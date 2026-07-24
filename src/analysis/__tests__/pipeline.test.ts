import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { AuditedSessionStatus, PrismaClient } from '../../generated/prisma/index.js';
import type { LintFinding } from '../../lint/index.js';
import type {
	AttachmentBucket,
	ParsedSession,
	RawUsage,
	ToolCallEvent,
} from '../../parser/index.js';
import type { RulebookResolution } from '../../rulebook/index.js';
import type { SessionStats } from '../../stats/index.js';
import { JUDGMENT_PURPOSE } from '../judgment.js';
import { runJudgmentPipelineForSession } from '../pipeline.js';

let testPrisma: PrismaClient;
let tempDir: string;

before(async () => {
	tempDir = await mkdtemp(path.join(os.tmpdir(), 'second-flow-pipeline-test-'));
	const databaseUrl = `file:${path.join(tempDir, 'test.db')}`;
	execSync(`npx prisma db push --url "${databaseUrl}"`, { stdio: 'ignore' });
	const adapter = new PrismaLibSql({ url: databaseUrl });
	testPrisma = new PrismaClient({ adapter });
});

after(async () => {
	await testPrisma.$disconnect();
	await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

beforeEach(async () => {
	await testPrisma.auditRunCall.deleteMany();
	await testPrisma.ruleProposal.deleteMany();
	await testPrisma.analysisNote.deleteMany();
	await testPrisma.auditedSession.deleteMany();
	await testPrisma.auditRun.deleteMany();
});

function emptyAttachments(): AttachmentBucket {
	return {
		hookSuccess: [],
		skillListing: [],
		deferredToolsDelta: [],
		agentListingDelta: [],
		mcpInstructionsDelta: [],
		outputStyle: [],
		unknown: [],
	};
}

function makeAssistantTurn(messageId: string, usage: RawUsage): ParsedSession['timeline'][number] {
	return {
		kind: 'assistant-turn',
		messageId,
		uuid: messageId,
		timestamp: 't',
		model: 'claude-sonnet-5',
		usage: {
			inputTokens: usage.input_tokens,
			outputTokens: usage.output_tokens,
			cacheReadInputTokens: usage.cache_read_input_tokens,
			cacheCreationInputTokens: usage.cache_creation_input_tokens,
			raw: usage,
		},
		content: [],
	};
}

function makeToolCall(toolUseId: string): ToolCallEvent {
	return {
		kind: 'tool-call',
		toolUseId,
		toolName: 'Bash',
		input: { command: 'git commit -m "x"' },
		callerUuid: 'turn-1',
		callTimestamp: 't',
		isSubagentSpawn: false,
		isBackground: false,
		result: { kind: 'sync', text: 'ok' },
	};
}

function makeSession(timeline: ParsedSession['timeline']): ParsedSession {
	return {
		sessionId: 'fixture-session',
		projectSlug: 'fixture-project',
		filePath: '/fake/path.jsonl',
		timeline,
		attachments: emptyAttachments(),
		noise: { count: 0, byType: {} },
		meta: { aiTitles: [] },
	};
}

function emptyStats(): SessionStats {
	return {
		sessionId: 'fixture-session',
		projectSlug: 'fixture-project',
		agents: { invocations: [], byType: [] },
		contextBudget: [],
		cache: { series: [], unexplainedDrops: [] },
		rateLimitHits: [],
		boundaryCandidates: [],
	};
}

function makeRulebook(): RulebookResolution {
	return {
		blocks: [
			{
				origin: 'file',
				layer: 'user',
				source: 'CLAUDE.md',
				text: 'Always label shell commands.',
			},
		],
		sources: {
			global: { path: 'CLAUDE.md', found: true },
			project: { path: null, found: false },
			hook: { count: 0 },
			environmental: { count: 0 },
		},
	};
}

const FAKE_USAGE = {
	input_tokens: 10,
	output_tokens: 5,
	cache_read_input_tokens: 0,
	cache_creation_input_tokens: 0,
};

function makeWellFormedAnthropic() {
	return {
		messages: {
			async create() {
				return {
					content: [
						{
							type: 'tool_use',
							id: 'tu_1',
							name: 'report_judgment_findings',
							input: {
								ruleRewriteProposals: [
									{
										targetRuleRef: 'CLAUDE.md',
										targetTextSnapshot: 'Always label shell commands.',
										proposedText: 'Always label shell commands with RUNNING:.',
										evidence: 'turn 1: unlabeled shell command',
									},
								],
								complianceNotes: [],
								environmentalInstructionIgnoredNotes: [],
								promptCoachingNotes: [],
							},
						},
					],
					usage: FAKE_USAGE,
				} as unknown as Anthropic.Message;
			},
		},
	};
}

test('a session with no gate triggers is waved through: zero rows written', async () => {
	const auditRun = await testPrisma.auditRun.create({ data: {} });
	const input = {
		session: makeSession([]),
		stats: emptyStats(),
		lintFindings: [] as LintFinding[],
		rulebook: makeRulebook(),
	};

	const outcome = await runJudgmentPipelineForSession(input, auditRun.id, async () => true, {
		prisma: testPrisma,
	});

	assert.deepEqual(outcome, { outcome: 'wavedThrough' });
	const sessions = await testPrisma.auditedSession.findMany();
	assert.equal(sessions.length, 0);
});

test('a triggered session the user declines writes zero rows', async () => {
	const auditRun = await testPrisma.auditRun.create({ data: {} });
	const timeline = [makeToolCall('call-a')];
	const lintFindings: LintFinding[] = [
		{
			checkerId: 'commit-gating',
			toolUseId: 'call-a',
			timestamp: 't',
			evidence: 'no approval',
		},
	];
	const input = {
		session: makeSession(timeline),
		stats: emptyStats(),
		lintFindings,
		rulebook: makeRulebook(),
	};

	const outcome = await runJudgmentPipelineForSession(input, auditRun.id, async () => false, {
		prisma: testPrisma,
	});

	assert.deepEqual(outcome, { outcome: 'declinedByUser' });
	const sessions = await testPrisma.auditedSession.findMany();
	assert.equal(sessions.length, 0);
});

test('a triggered session past the ceiling creates a skippedCeiling AuditedSession with zero children', async () => {
	const auditRun = await testPrisma.auditRun.create({ data: {} });
	await testPrisma.auditRunCall.create({
		data: {
			auditRunId: auditRun.id,
			model: 'claude-sonnet-5',
			purpose: JUDGMENT_PURPOSE,
			inputTokens: 1,
			outputTokens: 1,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
		},
	});
	const timeline = [makeToolCall('call-a')];
	const lintFindings: LintFinding[] = [
		{
			checkerId: 'commit-gating',
			toolUseId: 'call-a',
			timestamp: 't',
			evidence: 'no approval',
		},
	];
	const input = {
		session: makeSession(timeline),
		stats: emptyStats(),
		lintFindings,
		rulebook: makeRulebook(),
	};

	const outcome = await runJudgmentPipelineForSession(input, auditRun.id, async () => true, {
		prisma: testPrisma,
		maxSonnetCalls: 1,
	});

	assert.equal(outcome.outcome, 'skippedCeiling');
	const sessions = await testPrisma.auditedSession.findMany();
	assert.equal(sessions.length, 1);
	assert.equal(sessions[0].status, AuditedSessionStatus.skippedCeiling);
	const proposals = await testPrisma.ruleProposal.findMany();
	assert.equal(proposals.length, 0);
});

test("the happy path creates a completed AuditedSession plus correctly FK'd findings", async () => {
	const auditRun = await testPrisma.auditRun.create({ data: {} });
	const timeline = [makeToolCall('call-a')];
	const lintFindings: LintFinding[] = [
		{
			checkerId: 'commit-gating',
			toolUseId: 'call-a',
			timestamp: 't',
			evidence: 'no approval',
		},
	];
	const input = {
		session: makeSession(timeline),
		stats: emptyStats(),
		lintFindings,
		rulebook: makeRulebook(),
	};

	const outcome = await runJudgmentPipelineForSession(input, auditRun.id, async () => true, {
		prisma: testPrisma,
		anthropic: makeWellFormedAnthropic(),
	});

	assert.equal(outcome.outcome, 'completed');
	if (outcome.outcome !== 'completed') {
		return;
	}
	assert.equal(outcome.proposalsCreated, 1);
	assert.equal(outcome.notesCreated, 0);

	const sessions = await testPrisma.auditedSession.findMany();
	assert.equal(sessions.length, 1);
	assert.equal(sessions[0].status, AuditedSessionStatus.completed);

	const proposals = await testPrisma.ruleProposal.findMany({
		where: { auditedSessionId: outcome.auditedSessionId },
	});
	assert.equal(proposals.length, 1);
	assert.equal(proposals[0].targetRuleRef, 'CLAUDE.md');
});

test('the AuditedSession row records transcriptTokenTotal summed across every assistant turn', async () => {
	const auditRun = await testPrisma.auditRun.create({ data: {} });
	const timeline = [
		makeAssistantTurn('turn-1', {
			input_tokens: 100,
			output_tokens: 50,
			cache_read_input_tokens: 10,
			cache_creation_input_tokens: 5,
		}),
		makeToolCall('call-a'),
		makeAssistantTurn('turn-2', {
			input_tokens: 200,
			output_tokens: 25,
		}),
	];
	const lintFindings: LintFinding[] = [
		{
			checkerId: 'commit-gating',
			toolUseId: 'call-a',
			timestamp: 't',
			evidence: 'no approval',
		},
	];
	const input = {
		session: makeSession(timeline),
		stats: emptyStats(),
		lintFindings,
		rulebook: makeRulebook(),
	};

	const outcome = await runJudgmentPipelineForSession(input, auditRun.id, async () => true, {
		prisma: testPrisma,
		anthropic: makeWellFormedAnthropic(),
	});

	assert.equal(outcome.outcome, 'completed');
	const sessions = await testPrisma.auditedSession.findMany();
	assert.equal(sessions.length, 1);
	// turn-1: 100+50+10+5 = 165; turn-2 (no cache fields): 200+25 = 225; total 390. The
	// intervening tool-call event must not contribute anything.
	assert.equal(sessions[0].transcriptTokenTotal, 390);
});
