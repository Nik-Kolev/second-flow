import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import {
	AuditedSessionStatus,
	PrismaClient,
	RuleProposalStatus,
} from '../../generated/prisma/index.js';
import type { RuleProposal } from '../../generated/prisma/index.js';
import { createAuditRun, reconcileProposals, runStartupReconciliation } from '../ledger.js';

let testPrisma: PrismaClient;
let tempDir: string;

before(async () => {
	tempDir = await mkdtemp(path.join(os.tmpdir(), 'second-flow-ledger-test-'));
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

// Unlike activation.test.ts's cache lookups (always scoped by a unique rulebookHash, so tests
// never collide even sharing one DB), reconcileProposals processes every status: 'proposed' row
// in the table with no per-test scoping — that's the feature. Each test needs a clean slate.
beforeEach(async () => {
	await testPrisma.auditRunCall.deleteMany();
	await testPrisma.ruleProposal.deleteMany();
	await testPrisma.analysisNote.deleteMany();
	await testPrisma.auditedSession.deleteMany();
	await testPrisma.auditRun.deleteMany();
});

let fixtureCounter = 0;
async function writeFixture(content: string): Promise<string> {
	fixtureCounter++;
	const filePath = path.join(tempDir, `fixture-${fixtureCounter}.md`);
	await writeFile(filePath, content, 'utf-8');
	return filePath;
}

interface SeedOverrides {
	targetRuleRef: string;
	targetTextSnapshot?: string;
	proposedText?: string;
	evidence?: string;
	status?: RuleProposalStatus;
	auditedSessionId?: string;
}

// RuleProposal has no producer yet in this file's own tests (step 7 owns that) — reconciliation
// only reads/updates existing rows, so fixtures just need a valid parent to satisfy the FK.
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

async function seedProposal(overrides: SeedOverrides): Promise<RuleProposal> {
	const auditedSessionId = overrides.auditedSessionId ?? (await seedAuditedSession());
	return testPrisma.ruleProposal.create({
		data: {
			auditedSessionId,
			targetRuleRef: overrides.targetRuleRef,
			targetTextSnapshot: overrides.targetTextSnapshot ?? 'Always label shell commands.',
			proposedText:
				overrides.proposedText ?? 'Always label every shell command with RUNNING:.',
			evidence: overrides.evidence ?? 'turn 4: shell command sent with no label',
			status: overrides.status ?? RuleProposalStatus.proposed,
		},
	});
}

const FAKE_USAGE = {
	input_tokens: 123,
	output_tokens: 45,
	cache_read_input_tokens: 6,
	cache_creation_input_tokens: 7,
};

type FakeBehavior = { addressed: boolean } | 'malformed' | 'noToolUse' | 'reject';

interface FakeAnthropic {
	client: { messages: { create: (params: unknown) => Promise<Anthropic.Message> } };
	calls: () => number;
	lastParams: () => unknown;
}

function makeFakeAnthropic(behaviors: FakeBehavior[]): FakeAnthropic {
	let callCount = 0;
	let lastParams: unknown;
	return {
		client: {
			messages: {
				async create(params: unknown) {
					const behavior = behaviors[callCount] ?? behaviors[behaviors.length - 1];
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
									name: 'report_reconciliation',
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
								name: 'report_reconciliation',
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

async function newAuditRunId(): Promise<string> {
	const run = await createAuditRun({ prisma: testPrisma });
	return run.id;
}

test('substring still present is a no-op: zero Haiku calls, zero AuditRunCall rows', async () => {
	const filePath = await writeFixture('Always label shell commands. Other unrelated text.');
	const proposal = await seedProposal({
		targetRuleRef: filePath,
		targetTextSnapshot: 'Always label shell commands.',
	});
	const fake = makeFakeAnthropic([]);
	const auditRunId = await newAuditRunId();

	const summary = await reconcileProposals(auditRunId, {
		prisma: testPrisma,
		anthropic: fake.client,
	});

	assert.equal(summary.noOp, 1);
	assert.equal(summary.haikuCallsMade, 0);
	assert.equal(fake.calls(), 0);
	const refreshed = await testPrisma.ruleProposal.findUniqueOrThrow({
		where: { id: proposal.id },
	});
	assert.equal(refreshed.status, RuleProposalStatus.proposed);
	const callRows = await testPrisma.auditRunCall.findMany({ where: { auditRunId } });
	assert.equal(callRows.length, 0);
});

test('an empty snapshot never vacuously matches as a no-op', async () => {
	const filePath = await writeFixture('Any content at all, unrelated to an empty snapshot.');
	await seedProposal({ targetRuleRef: filePath, targetTextSnapshot: '' });
	const fake = makeFakeAnthropic([{ addressed: true }]);
	const auditRunId = await newAuditRunId();

	const summary = await reconcileProposals(auditRunId, {
		prisma: testPrisma,
		anthropic: fake.client,
	});

	assert.equal(
		fake.calls(),
		1,
		'an empty snapshot must fall through to the Haiku path, never a false no-op',
	);
	assert.equal(summary.noOp, 0);
	assert.equal(summary.resolved, 1);
});

test('substring gone + Haiku says addressed resolves the proposal and logs real usage', async () => {
	const filePath = await writeFixture('Shell commands need no label anymore.');
	const proposal = await seedProposal({
		targetRuleRef: filePath,
		targetTextSnapshot: 'Always label shell commands.',
	});
	const fake = makeFakeAnthropic([{ addressed: true }]);
	const auditRunId = await newAuditRunId();

	const summary = await reconcileProposals(auditRunId, {
		prisma: testPrisma,
		anthropic: fake.client,
	});

	assert.equal(summary.resolved, 1);
	assert.equal(summary.haikuCallsMade, 1);
	assert.equal(fake.calls(), 1);
	const refreshed = await testPrisma.ruleProposal.findUniqueOrThrow({
		where: { id: proposal.id },
	});
	assert.equal(refreshed.status, RuleProposalStatus.resolved);

	const callRows = await testPrisma.auditRunCall.findMany({ where: { auditRunId } });
	assert.equal(callRows.length, 1);
	assert.equal(callRows[0].model, 'claude-haiku-4-5');
	assert.equal(callRows[0].purpose, 'reconciliation');
	assert.equal(callRows[0].inputTokens, FAKE_USAGE.input_tokens);
	assert.equal(callRows[0].outputTokens, FAKE_USAGE.output_tokens);
	assert.equal(callRows[0].cacheReadTokens, FAKE_USAGE.cache_read_input_tokens);
	assert.equal(callRows[0].cacheCreationTokens, FAKE_USAGE.cache_creation_input_tokens);
});

test('substring gone + Haiku says not addressed leaves the proposal proposed, still logs spend', async () => {
	const filePath = await writeFixture('Reworded wording that does not fix the gap.');
	const proposal = await seedProposal({
		targetRuleRef: filePath,
		targetTextSnapshot: 'Always label shell commands.',
	});
	const fake = makeFakeAnthropic([{ addressed: false }]);
	const auditRunId = await newAuditRunId();

	const summary = await reconcileProposals(auditRunId, {
		prisma: testPrisma,
		anthropic: fake.client,
	});

	assert.equal(summary.stillProposed, 1);
	assert.equal(summary.haikuCallsMade, 1);
	const refreshed = await testPrisma.ruleProposal.findUniqueOrThrow({
		where: { id: proposal.id },
	});
	assert.equal(refreshed.status, RuleProposalStatus.proposed);
	const callRows = await testPrisma.auditRunCall.findMany({ where: { auditRunId } });
	assert.equal(callRows.length, 1);
});

test('target file no longer exists sets needsConfirm with zero Haiku calls', async () => {
	const missingPath = path.join(tempDir, 'never-created.md');
	const proposal = await seedProposal({ targetRuleRef: missingPath });
	const fake = makeFakeAnthropic([]);
	const auditRunId = await newAuditRunId();

	const summary = await reconcileProposals(auditRunId, {
		prisma: testPrisma,
		anthropic: fake.client,
	});

	assert.equal(summary.needsConfirm, 1);
	assert.equal(fake.calls(), 0);
	const refreshed = await testPrisma.ruleProposal.findUniqueOrThrow({
		where: { id: proposal.id },
	});
	assert.equal(refreshed.status, RuleProposalStatus.needsConfirm);
	const callRows = await testPrisma.auditRunCall.findMany({ where: { auditRunId } });
	assert.equal(callRows.length, 0);
});

test('an unexpected fs error (target is a directory, not a file) is isolated, not thrown', async () => {
	const dirPath = path.join(tempDir, 'a-directory-not-a-file');
	await mkdir(dirPath);
	const proposal = await seedProposal({ targetRuleRef: dirPath });
	const fake = makeFakeAnthropic([]);
	const auditRunId = await newAuditRunId();

	const summary = await reconcileProposals(auditRunId, {
		prisma: testPrisma,
		anthropic: fake.client,
	});

	assert.equal(summary.errored, 1);
	assert.equal(summary.haikuCallsMade, 0, 'the fs error happened before any Haiku call');
	assert.equal(fake.calls(), 0);
	const refreshed = await testPrisma.ruleProposal.findUniqueOrThrow({
		where: { id: proposal.id },
	});
	assert.equal(refreshed.status, RuleProposalStatus.proposed, 'status must be left untouched');
});

test('a dismissed proposal pointing at a nonexistent file is left untouched', async () => {
	const missingPath = path.join(tempDir, 'never-created-dismissed.md');
	const proposal = await seedProposal({
		targetRuleRef: missingPath,
		status: RuleProposalStatus.dismissed,
	});
	const fake = makeFakeAnthropic([]);
	const auditRunId = await newAuditRunId();

	const summary = await reconcileProposals(auditRunId, {
		prisma: testPrisma,
		anthropic: fake.client,
	});

	assert.equal(summary.totalProposed, 0, 'a dismissed row must not even be selected');
	const refreshed = await testPrisma.ruleProposal.findUniqueOrThrow({
		where: { id: proposal.id },
	});
	assert.equal(refreshed.status, RuleProposalStatus.dismissed);
});

test('a batch of independent proposals each resolve to their own outcome', async () => {
	const noOpPath = await writeFixture('Snapshot text is still here: keep as-is.');
	const resolvedPath = await writeFixture('Wording changed for the resolved case.');
	const missingPath = path.join(tempDir, 'batch-missing.md');

	await seedProposal({ targetRuleRef: noOpPath, targetTextSnapshot: 'keep as-is.' });
	await seedProposal({ targetRuleRef: resolvedPath, targetTextSnapshot: 'Original wording.' });
	await seedProposal({ targetRuleRef: missingPath });

	const fake = makeFakeAnthropic([{ addressed: true }]);
	const auditRunId = await newAuditRunId();

	const summary = await reconcileProposals(auditRunId, {
		prisma: testPrisma,
		anthropic: fake.client,
	});

	assert.equal(summary.totalProposed, 3);
	assert.equal(summary.noOp, 1);
	assert.equal(summary.resolved, 1);
	assert.equal(summary.needsConfirm, 1);
	assert.equal(summary.haikuCallsMade, 1);
});

test('two proposals sharing the same file and snapshot are reconciled independently, not deduped', async () => {
	const filePath = await writeFixture('The shared file wording has since changed entirely.');
	const proposalA = await seedProposal({
		targetRuleRef: filePath,
		targetTextSnapshot: 'Original shared wording.',
	});
	const proposalB = await seedProposal({
		targetRuleRef: filePath,
		targetTextSnapshot: 'Original shared wording.',
	});

	const fake = makeFakeAnthropic([{ addressed: true }, { addressed: false }]);
	const auditRunId = await newAuditRunId();

	const summary = await reconcileProposals(auditRunId, {
		prisma: testPrisma,
		anthropic: fake.client,
	});

	assert.equal(fake.calls(), 2, 'both proposals must trigger their own independent call');
	assert.equal(summary.resolved, 1);
	assert.equal(summary.stillProposed, 1);

	const refreshedA = await testPrisma.ruleProposal.findUniqueOrThrow({
		where: { id: proposalA.id },
	});
	const refreshedB = await testPrisma.ruleProposal.findUniqueOrThrow({
		where: { id: proposalB.id },
	});
	const statuses = [refreshedA.status, refreshedB.status].sort();
	assert.deepEqual(statuses, [RuleProposalStatus.proposed, RuleProposalStatus.resolved].sort());
});

test('a malformed tool input (missing addressed boolean) is isolated: errored, but spend is logged', async () => {
	const filePath = await writeFixture('Wording changed, response will be malformed.');
	const proposal = await seedProposal({
		targetRuleRef: filePath,
		targetTextSnapshot: 'Original wording gone now.',
	});
	const fake = makeFakeAnthropic(['malformed']);
	const auditRunId = await newAuditRunId();

	const summary = await reconcileProposals(auditRunId, {
		prisma: testPrisma,
		anthropic: fake.client,
	});

	assert.equal(summary.errored, 1);
	assert.equal(
		summary.haikuCallsMade,
		1,
		'the call completed and was billed, even though it errored',
	);
	const refreshed = await testPrisma.ruleProposal.findUniqueOrThrow({
		where: { id: proposal.id },
	});
	assert.equal(refreshed.status, RuleProposalStatus.proposed, 'status must be left untouched');
	const callRows = await testPrisma.auditRunCall.findMany({ where: { auditRunId } });
	assert.equal(callRows.length, 1, 'the call succeeded and real tokens were spent');
});

test('a response with no tool_use block is isolated: errored, but spend is logged', async () => {
	const filePath = await writeFixture('Wording changed, response will have no tool_use block.');
	await seedProposal({
		targetRuleRef: filePath,
		targetTextSnapshot: 'Original wording gone now.',
	});
	const fake = makeFakeAnthropic(['noToolUse']);
	const auditRunId = await newAuditRunId();

	const summary = await reconcileProposals(auditRunId, {
		prisma: testPrisma,
		anthropic: fake.client,
	});

	assert.equal(summary.errored, 1);
	assert.equal(
		summary.haikuCallsMade,
		1,
		'the call completed and was billed, even though it errored',
	);
	const callRows = await testPrisma.auditRunCall.findMany({ where: { auditRunId } });
	assert.equal(callRows.length, 1);
});

test('a simulated network failure logs zero spend and does not throw', async () => {
	const filePath = await writeFixture('Wording changed, network call will fail entirely.');
	const proposal = await seedProposal({
		targetRuleRef: filePath,
		targetTextSnapshot: 'Original wording gone now.',
	});
	const fake = makeFakeAnthropic(['reject']);
	const auditRunId = await newAuditRunId();

	const summary = await reconcileProposals(auditRunId, {
		prisma: testPrisma,
		anthropic: fake.client,
	});

	assert.equal(summary.errored, 1);
	assert.equal(summary.haikuCallsMade, 0, 'a call that never completed must not count as billed');
	const refreshed = await testPrisma.ruleProposal.findUniqueOrThrow({
		where: { id: proposal.id },
	});
	assert.equal(refreshed.status, RuleProposalStatus.proposed);
	const callRows = await testPrisma.auditRunCall.findMany({ where: { auditRunId } });
	assert.equal(callRows.length, 0, 'no response ever came back, so no usage exists to log');
});

test('one failing proposal does not abort reconciliation of the rest of the batch', async () => {
	const pathA = await writeFixture('First proposal wording changed, resolves cleanly.');
	const pathB = await writeFixture('Second proposal wording changed, call will fail.');
	const pathC = await writeFixture('Third proposal wording changed, resolves cleanly too.');

	await seedProposal({ targetRuleRef: pathA, targetTextSnapshot: 'First original wording.' });
	await seedProposal({ targetRuleRef: pathB, targetTextSnapshot: 'Second original wording.' });
	await seedProposal({ targetRuleRef: pathC, targetTextSnapshot: 'Third original wording.' });

	const fake = makeFakeAnthropic([{ addressed: true }, 'reject', { addressed: true }]);
	const auditRunId = await newAuditRunId();

	const summary = await reconcileProposals(auditRunId, {
		prisma: testPrisma,
		anthropic: fake.client,
	});

	assert.equal(summary.totalProposed, 3);
	assert.equal(
		summary.resolved,
		2,
		'the two unaffected proposals must still be fully reconciled',
	);
	assert.equal(summary.errored, 1);
	assert.equal(fake.calls(), 3);
	assert.equal(
		summary.haikuCallsMade,
		2,
		'the middle call never completed (network failure), so it was never billed',
	);
});

test('createAuditRun produces a usable row that reconcileProposals can be scoped to', async () => {
	const run = await createAuditRun({ prisma: testPrisma });
	assert.ok(run.startedAt);
	assert.equal(run.completedAt, null);

	const filePath = await writeFixture('Content that already matches the snapshot exactly.');
	await seedProposal({ targetRuleRef: filePath, targetTextSnapshot: 'exactly.' });
	const fake = makeFakeAnthropic([]);

	const summary = await reconcileProposals(run.id, {
		prisma: testPrisma,
		anthropic: fake.client,
	});
	assert.equal(summary.noOp, 1);
});

test('runStartupReconciliation with an empty ledger returns null and creates no AuditRun', async () => {
	const fake = makeFakeAnthropic([]);

	const result = await runStartupReconciliation({ prisma: testPrisma, anthropic: fake.client });

	assert.equal(result, null);
	assert.equal(fake.calls(), 0);
	const runs = await testPrisma.auditRun.findMany();
	assert.equal(runs.length, 0, 'the zero-proposal fast path must not create a run at all');
});

test('runStartupReconciliation with an outstanding proposal reconciles it and completes its run', async () => {
	const filePath = await writeFixture('Wording changed since the proposal was made.');
	const proposal = await seedProposal({
		targetRuleRef: filePath,
		targetTextSnapshot: 'Original wording, now gone.',
	});
	const fake = makeFakeAnthropic([{ addressed: true }]);

	const result = await runStartupReconciliation({ prisma: testPrisma, anthropic: fake.client });

	assert.ok(result, 'a non-empty ledger must actually run reconciliation');
	assert.equal(result.totalProposed, 1);
	assert.equal(result.resolved, 1);

	const refreshed = await testPrisma.ruleProposal.findUniqueOrThrow({
		where: { id: proposal.id },
	});
	assert.equal(refreshed.status, RuleProposalStatus.resolved);

	// Two runs exist: the FK-parent run behind the seeded AuditedSession (never completed) and the
	// one runStartupReconciliation created for itself — which must be the completed one, with the
	// Haiku spend logged against it.
	const runs = await testPrisma.auditRun.findMany();
	assert.equal(runs.length, 2);
	const reconcileRun = runs.find((run) => run.completedAt !== null);
	assert.ok(reconcileRun, 'the reconciliation run must be marked completed when done');
	const callRows = await testPrisma.auditRunCall.findMany({
		where: { auditRunId: reconcileRun.id },
	});
	assert.equal(callRows.length, 1);
	assert.equal(callRows[0].purpose, 'reconciliation');
});

test('a proposal that keeps failing reconciliation triggers a fresh Haiku call on every run', async () => {
	const filePath = await writeFixture('Wording changed once and never changes again.');
	await seedProposal({
		targetRuleRef: filePath,
		targetTextSnapshot: 'Wording that is now gone.',
	});

	const firstRun = await newAuditRunId();
	const firstFake = makeFakeAnthropic([{ addressed: false }]);
	const firstSummary = await reconcileProposals(firstRun, {
		prisma: testPrisma,
		anthropic: firstFake.client,
	});
	assert.equal(firstSummary.stillProposed, 1);

	const secondRun = await newAuditRunId();
	const secondFake = makeFakeAnthropic([{ addressed: false }]);
	const secondSummary = await reconcileProposals(secondRun, {
		prisma: testPrisma,
		anthropic: secondFake.client,
	});
	assert.equal(
		secondFake.calls(),
		1,
		'documents the known limitation: an unresolved proposal is re-checked every run',
	);
	assert.equal(secondSummary.stillProposed, 1);
});
