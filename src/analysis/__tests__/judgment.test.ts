import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import {
	AnalysisNoteKind,
	AuditedSessionStatus,
	PrismaClient,
} from '../../generated/prisma/index.js';
import type { RulebookResolution } from '../../rulebook/index.js';
import type { TimelineEvent } from '../../parser/index.js';
import { JUDGMENT_PURPOSE, persistJudgmentFindings, runJudgmentCall } from '../judgment.js';
import type { JudgmentFindings } from '../judgment.js';

let testPrisma: PrismaClient;
let tempDir: string;

before(async () => {
	tempDir = await mkdtemp(path.join(os.tmpdir(), 'second-flow-judgment-test-'));
	const databaseUrl = `file:${path.join(tempDir, 'test.db')}`;
	// No --accept-data-loss: the temp DB is always freshly created and empty, so there is never
	// data to lose — and passing that flag trips Prisma's AI-agent destructive-action gate even
	// against a throwaway file with nothing in it.
	execSync(`npx prisma db push --url "${databaseUrl}"`, { stdio: 'ignore' });
	const adapter = new PrismaLibSql({ url: databaseUrl });
	testPrisma = new PrismaClient({ adapter });
});

after(async () => {
	await testPrisma.$disconnect();
	// Windows can hold a brief file lock on the just-closed SQLite file — retry the unlink.
	await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

beforeEach(async () => {
	await testPrisma.auditRunCall.deleteMany();
	await testPrisma.ruleProposal.deleteMany();
	await testPrisma.analysisNote.deleteMany();
	await testPrisma.auditedSession.deleteMany();
	await testPrisma.auditRun.deleteMany();
});

async function seedAuditedSession(): Promise<string> {
	const auditRun = await testPrisma.auditRun.create({ data: {} });
	const session = await testPrisma.auditedSession.create({
		data: {
			transcriptSessionId: 'fixture-session',
			projectSlug: 'fixture-project',
			auditRunId: auditRun.id,
			status: AuditedSessionStatus.completed,
		},
	});
	return session.id;
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

function makeEvidenceWindow(): TimelineEvent[] {
	return [{ kind: 'user-message', text: 'Run the deploy script.' }];
}

const FAKE_USAGE = {
	input_tokens: 500,
	output_tokens: 120,
	cache_read_input_tokens: 10,
	cache_creation_input_tokens: 20,
};

type FakeBehavior = JudgmentToolInput | 'malformed' | 'noToolUse' | 'reject';
type JudgmentToolInput = Record<string, unknown>;

interface FakeAnthropic {
	client: { messages: { create: (params: unknown) => Promise<Anthropic.Message> } };
	calls: () => number;
	lastParams: () => unknown;
}

function makeFakeAnthropic(behavior: FakeBehavior): FakeAnthropic {
	let callCount = 0;
	let lastParams: unknown;
	return {
		client: {
			messages: {
				async create(params: unknown) {
					callCount++;
					lastParams = params;
					if (behavior === 'reject') {
						throw new Error('simulated network failure');
					}
					if (behavior === 'noToolUse') {
						return {
							content: [{ type: 'text', text: 'oops' }],
							usage: FAKE_USAGE,
						} as unknown as Anthropic.Message;
					}
					if (behavior === 'malformed') {
						return {
							content: [
								{
									type: 'tool_use',
									id: 'tu_1',
									name: 'report_judgment_findings',
									input: {},
								},
							],
							usage: FAKE_USAGE,
						} as unknown as Anthropic.Message;
					}
					return {
						content: [
							{
								type: 'tool_use',
								id: 'tu_1',
								name: 'report_judgment_findings',
								input: behavior,
							},
						],
						usage: FAKE_USAGE,
					} as unknown as Anthropic.Message;
				},
			},
		},
		calls: () => callCount,
		lastParams: () => lastParams,
	};
}

function wellFormedInput(): JudgmentToolInput {
	return {
		ruleRewriteProposals: [
			{
				targetRuleRef: 'CLAUDE.md',
				targetTextSnapshot: 'Always label shell commands.',
				proposedText: 'Always label shell commands with RUNNING:.',
				evidence: 'turn 3: unlabeled shell command',
			},
		],
		complianceNotes: [{ evidence: 'turn 5: format-before-commit followed correctly' }],
		environmentalInstructionIgnoredNotes: [],
		promptCoachingNotes: [{ evidence: 'turn 1: vague prompt caused 2 clarifying questions' }],
	};
}

test('a well-formed response returns completed findings and logs a Sonnet AuditRunCall', async () => {
	const fake = makeFakeAnthropic(wellFormedInput());
	const auditRun = await testPrisma.auditRun.create({ data: {} });

	const outcome = await runJudgmentCall(auditRun.id, makeRulebook(), makeEvidenceWindow(), {
		prisma: testPrisma,
		anthropic: fake.client,
	});

	assert.equal(outcome.outcome, 'completed');
	if (outcome.outcome !== 'completed') {
		return;
	}
	assert.equal(outcome.findings.ruleRewriteProposals.length, 1);
	assert.equal(outcome.findings.complianceNotes.length, 1);
	assert.equal(outcome.findings.promptCoachingNotes.length, 1);

	const callRows = await testPrisma.auditRunCall.findMany({ where: { auditRunId: auditRun.id } });
	assert.equal(callRows.length, 1);
	assert.equal(callRows[0].model, 'claude-sonnet-5');
	assert.equal(callRows[0].purpose, JUDGMENT_PURPOSE);
	assert.equal(callRows[0].inputTokens, FAKE_USAGE.input_tokens);
});

test("a rule-rewrite proposal citing a targetRuleRef outside the rulebook's file blocks is dropped", async () => {
	const input = wellFormedInput();
	input.ruleRewriteProposals = [
		...(input.ruleRewriteProposals as unknown[]),
		{
			targetRuleRef: 'hallucinated-file-that-was-never-in-the-rulebook.md',
			targetTextSnapshot: 'Some invented wording.',
			proposedText: 'Some invented rewrite.',
			evidence: 'turn 9: fabricated citation',
		},
	];
	const fake = makeFakeAnthropic(input);
	const auditRun = await testPrisma.auditRun.create({ data: {} });

	const outcome = await runJudgmentCall(auditRun.id, makeRulebook(), makeEvidenceWindow(), {
		prisma: testPrisma,
		anthropic: fake.client,
	});

	assert.equal(outcome.outcome, 'completed');
	if (outcome.outcome !== 'completed') {
		return;
	}
	assert.equal(
		outcome.findings.ruleRewriteProposals.length,
		1,
		'only the proposal citing a real rulebook file block should survive',
	);
	assert.equal(outcome.findings.ruleRewriteProposals[0].targetRuleRef, 'CLAUDE.md');
});

test('persistJudgmentFindings writes RuleProposal and AnalysisNote rows against the right session', async () => {
	const auditedSessionId = await seedAuditedSession();
	const findings: JudgmentFindings = {
		ruleRewriteProposals: [
			{
				targetRuleRef: 'CLAUDE.md',
				targetTextSnapshot: 'Always label shell commands.',
				proposedText: 'Always label shell commands with RUNNING:.',
				evidence: 'turn 3',
			},
		],
		complianceNotes: [{ evidence: 'turn 5' }],
		environmentalInstructionIgnoredNotes: [{ evidence: 'turn 7' }],
		promptCoachingNotes: [{ evidence: 'turn 1' }, { evidence: 'turn 2' }],
	};

	const result = await persistJudgmentFindings(auditedSessionId, findings, testPrisma);

	assert.equal(result.proposalsCreated, 1);
	assert.equal(result.notesCreated, 4);

	const proposals = await testPrisma.ruleProposal.findMany({ where: { auditedSessionId } });
	assert.equal(proposals.length, 1);
	assert.equal(proposals[0].targetRuleRef, 'CLAUDE.md');

	const notes = await testPrisma.analysisNote.findMany({ where: { auditedSessionId } });
	assert.equal(notes.length, 4);
	const kinds = notes.map((note) => note.kind).sort();
	assert.deepEqual(
		kinds,
		[
			AnalysisNoteKind.compliance,
			AnalysisNoteKind.environmentalInstruction,
			AnalysisNoteKind.promptCoaching,
			AnalysisNoteKind.promptCoaching,
		].sort(),
	);
});

test('a malformed tool input is isolated: errored, but spend is logged', async () => {
	const fake = makeFakeAnthropic('malformed');
	const auditRun = await testPrisma.auditRun.create({ data: {} });

	const outcome = await runJudgmentCall(auditRun.id, makeRulebook(), makeEvidenceWindow(), {
		prisma: testPrisma,
		anthropic: fake.client,
	});

	assert.equal(outcome.outcome, 'errored');
	if (outcome.outcome === 'errored') {
		assert.equal(outcome.usageLogged, true);
	}
	const callRows = await testPrisma.auditRunCall.findMany({ where: { auditRunId: auditRun.id } });
	assert.equal(callRows.length, 1, 'the call succeeded and real tokens were spent');
});

test('a response with no tool_use block is isolated: errored, but spend is logged', async () => {
	const fake = makeFakeAnthropic('noToolUse');
	const auditRun = await testPrisma.auditRun.create({ data: {} });

	const outcome = await runJudgmentCall(auditRun.id, makeRulebook(), makeEvidenceWindow(), {
		prisma: testPrisma,
		anthropic: fake.client,
	});

	assert.equal(outcome.outcome, 'errored');
	const callRows = await testPrisma.auditRunCall.findMany({ where: { auditRunId: auditRun.id } });
	assert.equal(callRows.length, 1);
});

test('a simulated network failure logs zero spend and does not throw', async () => {
	const fake = makeFakeAnthropic('reject');
	const auditRun = await testPrisma.auditRun.create({ data: {} });

	const outcome = await runJudgmentCall(auditRun.id, makeRulebook(), makeEvidenceWindow(), {
		prisma: testPrisma,
		anthropic: fake.client,
	});

	assert.equal(outcome.outcome, 'errored');
	if (outcome.outcome === 'errored') {
		assert.equal(outcome.usageLogged, false);
	}
	const callRows = await testPrisma.auditRunCall.findMany({ where: { auditRunId: auditRun.id } });
	assert.equal(callRows.length, 0, 'no response ever came back, so no usage exists to log');
});
