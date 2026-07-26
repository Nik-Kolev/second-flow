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
	// Model resolution reads AuditSettings when no deps override is given — each test starts from
	// an unseeded settings table so the lazily-created default is deterministic.
	await testPrisma.auditSettings.deleteMany();
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

const MEMORY_BLOCK_SOURCE = '/home/.claude/memory/gotcha.md';

function makeRulebook(opts: { withMemoryBlock?: boolean } = {}): RulebookResolution {
	const blocks: RulebookResolution['blocks'] = [
		{
			origin: 'file',
			layer: 'user',
			source: 'CLAUDE.md',
			text: 'Always label shell commands.',
		},
	];
	if (opts.withMemoryBlock) {
		blocks.push({
			origin: 'memory',
			layer: 'memory',
			sourceKind: 'global-memory',
			source: MEMORY_BLOCK_SOURCE,
			text: 'Do not skip the format step before committing.',
		});
	}
	return {
		blocks,
		sources: {
			global: { path: 'CLAUDE.md', found: true },
			project: { path: null, found: false },
			hook: { count: 0 },
			environmental: { count: 0 },
			memory: { count: opts.withMemoryBlock ? 1 : 0 },
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
		complianceNotes: [
			{
				evidence: 'turn 5: format-before-commit followed correctly',
				ruleRef: 'CLAUDE.md',
				outcome: 'positive',
			},
		],
		environmentalInstructionIgnoredNotes: [],
		promptCoachingNotes: [
			{
				evidence: 'turn 1: vague prompt caused 2 clarifying questions',
				ruleRef: 'general',
				suggestion:
					'State the acceptance criteria up front instead of leaving scope implicit.',
			},
		],
	};
}

test('a well-formed response returns completed findings and logs a Sonnet AuditRunCall', async () => {
	const fake = makeFakeAnthropic(wellFormedInput());
	const auditRun = await testPrisma.auditRun.create({ data: {} });

	const outcome = await runJudgmentCall(auditRun.id, makeRulebook(), makeEvidenceWindow(), [], {
		prisma: testPrisma,
		anthropic: fake.client,
	});

	assert.equal(outcome.outcome, 'completed');
	if (outcome.outcome !== 'completed') {
		return;
	}
	assert.equal(outcome.findings.ruleRewriteProposals.length, 1);
	assert.equal(outcome.findings.complianceNotes.length, 1);
	assert.equal(outcome.findings.complianceNotes[0].outcome, 'positive');
	assert.equal(outcome.findings.promptCoachingNotes.length, 1);
	assert.ok(outcome.findings.promptCoachingNotes[0].suggestion.length > 0);
	assert.equal(outcome.droppedProposalCount, 0);

	const callRows = await testPrisma.auditRunCall.findMany({ where: { auditRunId: auditRun.id } });
	assert.equal(callRows.length, 1);
	assert.equal(callRows[0].model, 'claude-sonnet-5');
	assert.equal(callRows[0].purpose, JUDGMENT_PURPOSE);
	assert.equal(callRows[0].inputTokens, FAKE_USAGE.input_tokens);
	assert.equal(callRows[0].rawResponse, null, 'a cleanly-parsed call stores no raw response');
	assert.equal(callRows[0].errorText, null);
});

test('flagged signals (e.g. a rate-limit hit not visible in the evidence text) reach the prompt', async () => {
	const fake = makeFakeAnthropic(wellFormedInput());
	const auditRun = await testPrisma.auditRun.create({ data: {} });
	const signal = 'Rate limit hit (status 429)';

	await runJudgmentCall(auditRun.id, makeRulebook(), makeEvidenceWindow(), [signal], {
		prisma: testPrisma,
		anthropic: fake.client,
	});

	const requestParams = fake.lastParams() as { messages: Array<{ content: string }> };
	assert.ok(requestParams.messages[0].content.includes(signal));
});

test('an empty flaggedSignals list produces no "Flagged signals" section', async () => {
	const fake = makeFakeAnthropic(wellFormedInput());
	const auditRun = await testPrisma.auditRun.create({ data: {} });

	await runJudgmentCall(auditRun.id, makeRulebook(), makeEvidenceWindow(), [], {
		prisma: testPrisma,
		anthropic: fake.client,
	});

	const requestParams = fake.lastParams() as { messages: Array<{ content: string }> };
	assert.ok(!requestParams.messages[0].content.includes('Flagged signals'));
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

	const outcome = await runJudgmentCall(auditRun.id, makeRulebook(), makeEvidenceWindow(), [], {
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
	assert.equal(
		outcome.droppedProposalCount,
		1,
		'a silently-filtered proposal must be counted, never invisible',
	);
});

test('a note citing a memory-block source is preserved, not coerced to "general"', async () => {
	const input = wellFormedInput();
	input.complianceNotes = [
		{
			evidence: 'turn 5: ignored a documented gotcha',
			ruleRef: MEMORY_BLOCK_SOURCE,
			outcome: 'violation',
		},
	];
	const fake = makeFakeAnthropic(input);
	const auditRun = await testPrisma.auditRun.create({ data: {} });

	const outcome = await runJudgmentCall(
		auditRun.id,
		makeRulebook({ withMemoryBlock: true }),
		makeEvidenceWindow(),
		[],
		{ prisma: testPrisma, anthropic: fake.client },
	);

	assert.equal(outcome.outcome, 'completed');
	if (outcome.outcome !== 'completed') {
		return;
	}
	assert.equal(
		outcome.findings.complianceNotes[0].ruleRef,
		MEMORY_BLOCK_SOURCE,
		'a note may cite a memory/stack file by path — only proposals are restricted to CLAUDE.md files',
	);
});

test('a rule-rewrite proposal citing a memory-block source is dropped — memory files are never rewrite targets', async () => {
	const input = wellFormedInput();
	input.ruleRewriteProposals = [
		...(input.ruleRewriteProposals as unknown[]),
		{
			targetRuleRef: MEMORY_BLOCK_SOURCE,
			targetTextSnapshot: 'Do not skip the format step before committing.',
			proposedText: 'Some invented rewrite of a memory file.',
			evidence: 'turn 9: proposal targeting a memory file',
		},
	];
	const fake = makeFakeAnthropic(input);
	const auditRun = await testPrisma.auditRun.create({ data: {} });

	const outcome = await runJudgmentCall(
		auditRun.id,
		makeRulebook({ withMemoryBlock: true }),
		makeEvidenceWindow(),
		[],
		{ prisma: testPrisma, anthropic: fake.client },
	);

	assert.equal(outcome.outcome, 'completed');
	if (outcome.outcome !== 'completed') {
		return;
	}
	assert.equal(
		outcome.findings.ruleRewriteProposals.length,
		1,
		'only the proposal citing the real CLAUDE.md file block should survive',
	);
	assert.equal(outcome.findings.ruleRewriteProposals[0].targetRuleRef, 'CLAUDE.md');
	assert.equal(
		outcome.droppedProposalCount,
		1,
		'a proposal targeting a memory/stack file must be dropped and counted, same as any other invalid target',
	);
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
		complianceNotes: [{ evidence: 'turn 5', ruleRef: 'CLAUDE.md', outcome: 'violation' }],
		environmentalInstructionIgnoredNotes: [
			{ evidence: 'turn 7', ruleRef: 'general', outcome: 'positive' },
		],
		promptCoachingNotes: [
			{ evidence: 'turn 1', ruleRef: 'general', suggestion: 'Name the acceptance criteria.' },
			{
				evidence: 'turn 2',
				ruleRef: 'general',
				suggestion: 'Split the two asks into two turns.',
			},
		],
	};

	const result = await persistJudgmentFindings(auditedSessionId, findings, testPrisma);

	assert.equal(result.proposalsCreated, 1);
	assert.equal(result.notesCreated, 4);

	const proposals = await testPrisma.ruleProposal.findMany({ where: { auditedSessionId } });
	assert.equal(proposals.length, 1);
	assert.equal(proposals[0].targetRuleRef, 'CLAUDE.md');

	const notes = await testPrisma.analysisNote.findMany({ where: { auditedSessionId } });
	assert.equal(notes.length, 4);
	const complianceNote = notes.find((note) => note.kind === AnalysisNoteKind.compliance);
	assert.equal(complianceNote?.ruleRef, 'CLAUDE.md', 'ruleRef must be persisted on the row');
	assert.equal(complianceNote?.outcome, 'violation', 'outcome must be persisted on the row');
	const envNote = notes.find((note) => note.kind === AnalysisNoteKind.environmentalInstruction);
	assert.equal(envNote?.outcome, 'positive');
	const promptNotes = notes.filter((note) => note.kind === AnalysisNoteKind.promptCoaching);
	assert.deepEqual(
		promptNotes.map((note) => note.suggestion).sort(),
		['Name the acceptance criteria.', 'Split the two asks into two turns.'],
		'suggestion must be persisted on promptCoaching rows',
	);
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

	const outcome = await runJudgmentCall(auditRun.id, makeRulebook(), makeEvidenceWindow(), [], {
		prisma: testPrisma,
		anthropic: fake.client,
	});

	assert.equal(outcome.outcome, 'errored');
	if (outcome.outcome === 'errored') {
		assert.equal(outcome.usageLogged, true);
	}
	const callRows = await testPrisma.auditRunCall.findMany({ where: { auditRunId: auditRun.id } });
	assert.equal(callRows.length, 1, 'the call succeeded and real tokens were spent');
	assert.ok(
		callRows[0].rawResponse,
		'the discarded response must survive on the call row for reconstruction',
	);
	const raw = JSON.parse(callRows[0].rawResponse) as { content: unknown };
	assert.ok(Array.isArray(raw.content), 'rawResponse must round-trip as the full API message');
	assert.match(callRows[0].errorText ?? '', /ruleRewriteProposals/);
});

test('a response with no tool_use block is isolated: errored, but spend is logged', async () => {
	const fake = makeFakeAnthropic('noToolUse');
	const auditRun = await testPrisma.auditRun.create({ data: {} });

	const outcome = await runJudgmentCall(auditRun.id, makeRulebook(), makeEvidenceWindow(), [], {
		prisma: testPrisma,
		anthropic: fake.client,
	});

	assert.equal(outcome.outcome, 'errored');
	const callRows = await testPrisma.auditRunCall.findMany({ where: { auditRunId: auditRun.id } });
	assert.equal(callRows.length, 1);
	assert.ok(callRows[0].rawResponse);
	assert.match(callRows[0].errorText ?? '', /no tool_use block/);
});

test('a note citing an invented ruleRef is coerced to "general", never dropped', async () => {
	const input = wellFormedInput();
	input.complianceNotes = [
		{
			evidence: 'turn 5: real note, invented file ref',
			ruleRef: 'invented-file.md',
			outcome: 'violation',
		},
	];
	const fake = makeFakeAnthropic(input);
	const auditRun = await testPrisma.auditRun.create({ data: {} });

	const outcome = await runJudgmentCall(auditRun.id, makeRulebook(), makeEvidenceWindow(), [], {
		prisma: testPrisma,
		anthropic: fake.client,
	});

	assert.equal(outcome.outcome, 'completed');
	if (outcome.outcome !== 'completed') {
		return;
	}
	assert.equal(outcome.findings.complianceNotes.length, 1, 'the note must survive');
	assert.equal(
		outcome.findings.complianceNotes[0].ruleRef,
		'general',
		'an invalid ruleRef degrades to "general" instead of silently dropping the note',
	);
});

test('a note missing its ruleRef is a parse failure: errored, spend logged, raw response kept', async () => {
	const input = wellFormedInput();
	input.complianceNotes = [{ evidence: 'note with no ruleRef at all', outcome: 'violation' }];
	const fake = makeFakeAnthropic(input);
	const auditRun = await testPrisma.auditRun.create({ data: {} });

	const outcome = await runJudgmentCall(auditRun.id, makeRulebook(), makeEvidenceWindow(), [], {
		prisma: testPrisma,
		anthropic: fake.client,
	});

	assert.equal(outcome.outcome, 'errored');
	const callRows = await testPrisma.auditRunCall.findMany({ where: { auditRunId: auditRun.id } });
	assert.equal(callRows.length, 1);
	assert.match(callRows[0].errorText ?? '', /ruleRef/);
});

test('the prompt lists the valid ruleRef values for notes', async () => {
	const fake = makeFakeAnthropic(wellFormedInput());
	const auditRun = await testPrisma.auditRun.create({ data: {} });

	await runJudgmentCall(auditRun.id, makeRulebook(), makeEvidenceWindow(), [], {
		prisma: testPrisma,
		anthropic: fake.client,
	});

	const requestParams = fake.lastParams() as { messages: Array<{ content: string }> };
	assert.ok(requestParams.messages[0].content.includes('Valid ruleRef values'));
	assert.ok(requestParams.messages[0].content.includes('- CLAUDE.md'));
	assert.ok(requestParams.messages[0].content.includes('- general'));
});

test('a deps judgmentModel override wins and lands in AuditRunCall.model', async () => {
	const fake = makeFakeAnthropic(wellFormedInput());
	const auditRun = await testPrisma.auditRun.create({ data: {} });

	await runJudgmentCall(auditRun.id, makeRulebook(), makeEvidenceWindow(), [], {
		prisma: testPrisma,
		anthropic: fake.client,
		judgmentModel: 'claude-opus-5',
	});

	const requestParams = fake.lastParams() as { model: string };
	assert.equal(requestParams.model, 'claude-opus-5');
	const callRows = await testPrisma.auditRunCall.findMany({ where: { auditRunId: auditRun.id } });
	assert.equal(callRows[0].model, 'claude-opus-5', 'spend must be billed under the model used');
});

test('without an override the persisted AuditSettings.judgmentModel decides the model', async () => {
	await testPrisma.auditSettings.create({
		data: { maxSonnetCallsPerRun: 10, judgmentModel: 'claude-fable-5' },
	});
	const fake = makeFakeAnthropic(wellFormedInput());
	const auditRun = await testPrisma.auditRun.create({ data: {} });

	await runJudgmentCall(auditRun.id, makeRulebook(), makeEvidenceWindow(), [], {
		prisma: testPrisma,
		anthropic: fake.client,
	});

	const requestParams = fake.lastParams() as { model: string };
	assert.equal(requestParams.model, 'claude-fable-5');
});

test('stop_reason refusal is an errored outcome with its own explanation, spend logged', async () => {
	const refusingAnthropic = {
		messages: {
			async create() {
				return {
					content: [],
					stop_reason: 'refusal',
					usage: FAKE_USAGE,
				} as unknown as Anthropic.Message;
			},
		},
	};
	const auditRun = await testPrisma.auditRun.create({ data: {} });

	const outcome = await runJudgmentCall(auditRun.id, makeRulebook(), makeEvidenceWindow(), [], {
		prisma: testPrisma,
		anthropic: refusingAnthropic,
	});

	assert.equal(outcome.outcome, 'errored');
	if (outcome.outcome === 'errored') {
		assert.equal(outcome.usageLogged, true, 'a refusal still bills the tokens it consumed');
	}
	const callRows = await testPrisma.auditRunCall.findMany({ where: { auditRunId: auditRun.id } });
	assert.equal(callRows.length, 1);
	assert.match(
		callRows[0].errorText ?? '',
		/refusal/,
		'the error must say refusal, not a misleading "no tool_use block"',
	);
	assert.ok(callRows[0].rawResponse);
});

test('a simulated network failure logs zero spend and does not throw', async () => {
	const fake = makeFakeAnthropic('reject');
	const auditRun = await testPrisma.auditRun.create({ data: {} });

	const outcome = await runJudgmentCall(auditRun.id, makeRulebook(), makeEvidenceWindow(), [], {
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

test('a compliance note with an invalid outcome value is a parse failure', async () => {
	const input = wellFormedInput();
	input.complianceNotes = [
		{ evidence: 'turn 5: some finding', ruleRef: 'CLAUDE.md', outcome: 'compliant' },
	];
	const fake = makeFakeAnthropic(input);
	const auditRun = await testPrisma.auditRun.create({ data: {} });

	const outcome = await runJudgmentCall(auditRun.id, makeRulebook(), makeEvidenceWindow(), [], {
		prisma: testPrisma,
		anthropic: fake.client,
	});

	assert.equal(outcome.outcome, 'errored');
	const callRows = await testPrisma.auditRunCall.findMany({ where: { auditRunId: auditRun.id } });
	assert.equal(callRows.length, 1);
	assert.match(callRows[0].errorText ?? '', /outcome/);
});

test('a promptCoaching note missing its suggestion is a parse failure', async () => {
	const input = wellFormedInput();
	input.promptCoachingNotes = [{ evidence: 'turn 1: vague prompt', ruleRef: 'general' }];
	const fake = makeFakeAnthropic(input);
	const auditRun = await testPrisma.auditRun.create({ data: {} });

	const outcome = await runJudgmentCall(auditRun.id, makeRulebook(), makeEvidenceWindow(), [], {
		prisma: testPrisma,
		anthropic: fake.client,
	});

	assert.equal(outcome.outcome, 'errored');
	const callRows = await testPrisma.auditRunCall.findMany({ where: { auditRunId: auditRun.id } });
	assert.equal(callRows.length, 1);
	assert.match(callRows[0].errorText ?? '', /suggestion/);
});

test('a promptCoaching note with an empty suggestion is a parse failure', async () => {
	const input = wellFormedInput();
	input.promptCoachingNotes = [
		{ evidence: 'turn 1: vague prompt', ruleRef: 'general', suggestion: '' },
	];
	const fake = makeFakeAnthropic(input);
	const auditRun = await testPrisma.auditRun.create({ data: {} });

	const outcome = await runJudgmentCall(auditRun.id, makeRulebook(), makeEvidenceWindow(), [], {
		prisma: testPrisma,
		anthropic: fake.client,
	});

	assert.equal(outcome.outcome, 'errored');
	const callRows = await testPrisma.auditRunCall.findMany({ where: { auditRunId: auditRun.id } });
	assert.equal(callRows.length, 1);
	assert.match(callRows[0].errorText ?? '', /suggestion/);
});

test('the prompt instructs splitting a mixed-verdict incident into two notes', async () => {
	const fake = makeFakeAnthropic(wellFormedInput());
	const auditRun = await testPrisma.auditRun.create({ data: {} });

	await runJudgmentCall(auditRun.id, makeRulebook(), makeEvidenceWindow(), [], {
		prisma: testPrisma,
		anthropic: fake.client,
	});

	const requestParams = fake.lastParams() as { messages: Array<{ content: string }> };
	assert.ok(requestParams.messages[0].content.includes('two separate notes'));
	assert.ok(requestParams.messages[0].content.includes('concrete rephrasing'));
});
