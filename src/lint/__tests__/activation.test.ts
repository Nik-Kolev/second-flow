import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { PrismaClient } from '../../generated/prisma/index.js';
import type { ToolCallEvent } from '../../parser/index.js';
import type { RulebookResolution } from '../../rulebook/index.js';
import { getActivationMap, runActivatedCheckers } from '../activation.js';
import { CHECKERS } from '../checkers.js';

let testPrisma: PrismaClient;
let tempDir: string;

before(async () => {
	tempDir = await mkdtemp(path.join(os.tmpdir(), 'second-flow-activation-test-'));
	const databaseUrl = `file:${path.join(tempDir, 'test.db')}`;
	// No --accept-data-loss: the temp DB is always freshly created and empty, so there is
	// never data to lose — and passing that flag trips Prisma's AI-agent destructive-action
	// gate even against a throwaway file with nothing in it.
	execSync(`npx prisma db push --url "${databaseUrl}"`, { stdio: 'ignore' });
	const adapter = new PrismaLibSql({ url: databaseUrl });
	testPrisma = new PrismaClient({ adapter });
});

after(async () => {
	await testPrisma.$disconnect();
	// Windows can hold a brief file lock on the just-closed SQLite file — retry the unlink.
	await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

function makeRulebook(text: string): RulebookResolution {
	return {
		blocks: [{ origin: 'file', layer: 'user', source: 'CLAUDE.md', text }],
		sources: {
			global: { path: 'CLAUDE.md', found: true },
			project: { path: null, found: false },
			hook: { count: 0 },
			environmental: { count: 0 },
		},
	};
}

function makeCommitCall(): ToolCallEvent {
	return {
		kind: 'tool-call',
		toolUseId: 'a',
		toolName: 'Bash',
		input: { command: 'git commit -m "x"' },
		callerUuid: 'u1',
		callTimestamp: 't',
		isSubagentSpawn: false,
		isBackground: false,
		result: { kind: 'sync', text: 'ok' },
	};
}

interface FakeAnthropic {
	client: { messages: { create: (params: unknown) => Promise<Anthropic.Message> } };
	calls: () => number;
	lastParams: () => unknown;
}

function makeFakeAnthropic(activationInput: unknown): FakeAnthropic {
	let callCount = 0;
	let lastParams: unknown;
	return {
		client: {
			messages: {
				async create(params: unknown) {
					callCount++;
					lastParams = params;
					return {
						content: [
							{
								type: 'tool_use',
								id: 'tu_1',
								name: 'report_activation',
								input: activationInput,
							},
						],
						usage: {
							input_tokens: 120,
							output_tokens: 40,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					} as unknown as Anthropic.Message;
				},
			},
		},
		calls: () => callCount,
		lastParams: () => lastParams,
	};
}

test('cache miss calls Haiku once, persists rows, and a second call hits the cache', async () => {
	// AuditRunCall rows are not rulebook-hash-scoped like the cache rows, so this test wipes the
	// table locally to make its count assertions order-independent.
	await testPrisma.auditRunCall.deleteMany();
	const rulebook = makeRulebook('Rulebook A: requires commit-gating.');
	const fake = makeFakeAnthropic({
		'commit-gating': true,
		'format-before-commit': false,
		'shell-command-label': true,
		'boundary-compact': false,
	});

	const first = await getActivationMap(rulebook, { prisma: testPrisma, anthropic: fake.client });
	assert.deepEqual(first, {
		'commit-gating': true,
		'format-before-commit': false,
		'shell-command-label': true,
		'boundary-compact': false,
	});
	assert.equal(fake.calls(), 1);

	const requestParams = fake.lastParams() as {
		tool_choice: { type: string; name: string };
		messages: Array<{ content: string }>;
	};
	assert.deepEqual(requestParams.tool_choice, { type: 'tool', name: 'report_activation' });
	for (const checker of CHECKERS) {
		assert.ok(requestParams.messages[0].content.includes(checker.ruleShapeDescription));
	}

	const callRows = await testPrisma.auditRunCall.findMany();
	assert.equal(callRows.length, 1, 'the Haiku activation call must land on the spend meter');
	assert.equal(callRows[0].purpose, 'activation');
	assert.equal(callRows[0].auditRunId, null, 'activation happens outside any audit run');
	assert.equal(callRows[0].model, 'claude-haiku-4-5');
	assert.equal(callRows[0].inputTokens, 120);
	assert.equal(callRows[0].outputTokens, 40);

	const second = await getActivationMap(rulebook, { prisma: testPrisma, anthropic: fake.client });
	assert.deepEqual(second, first);
	assert.equal(fake.calls(), 1, 'second call against the same rulebook must hit the DB cache');
	assert.equal(
		await testPrisma.auditRunCall.count(),
		1,
		'a cache hit spends nothing, so it must log nothing',
	);
});

test('a tool_use input missing a checker boolean throws', async () => {
	const rulebook = makeRulebook('Rulebook B: malformed response test.');
	const fake = makeFakeAnthropic({ 'commit-gating': true, 'format-before-commit': false });

	await assert.rejects(
		() => getActivationMap(rulebook, { prisma: testPrisma, anthropic: fake.client }),
		/shell-command-label/,
	);
});

test('a response with no tool_use block throws', async () => {
	await testPrisma.auditRunCall.deleteMany();
	const rulebook = makeRulebook('Rulebook C: no tool_use block test.');
	const fake = {
		client: {
			messages: {
				async create() {
					return {
						content: [{ type: 'text', text: 'oops' }],
						usage: {
							input_tokens: 120,
							output_tokens: 40,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					} as unknown as Anthropic.Message;
				},
			},
		},
	};

	await assert.rejects(
		() => getActivationMap(rulebook, { prisma: testPrisma, anthropic: fake.client }),
		/no tool_use block/,
	);

	const activationCalls = await testPrisma.auditRunCall.findMany({
		where: { purpose: 'activation' },
	});
	assert.equal(
		activationCalls.length,
		1,
		'the response came back and was billed — spend must be logged even when parsing fails',
	);
});

test('runActivatedCheckers only runs checkers the activation map marks true', async () => {
	const rulebook = makeRulebook('Rulebook D: gating test.');
	const fake = makeFakeAnthropic({
		'commit-gating': false,
		'format-before-commit': false,
		'shell-command-label': true,
		'boundary-compact': false,
	});
	const timeline = [makeCommitCall()];

	const findings = await runActivatedCheckers(timeline, rulebook, {
		prisma: testPrisma,
		anthropic: fake.client,
	});

	assert.equal(findings.length, 1);
	assert.equal(findings[0].checkerId, 'shell-command-label');
});

test('a stale checker id in the cache is not treated as a complete cache', async () => {
	const rulebook = makeRulebook('Rulebook E: stale checker id test.');
	const seedFake = makeFakeAnthropic({
		'commit-gating': true,
		'format-before-commit': true,
		'shell-command-label': true,
		'boundary-compact': false,
	});
	await getActivationMap(rulebook, { prisma: testPrisma, anthropic: seedFake.client });

	// Simulate a checker that was later renamed/removed: the row survives under an
	// id no longer in CHECKERS, while the total row count for this hash is unchanged.
	const staleRow = await testPrisma.checkerActivation.findFirst({
		where: { checkerId: 'shell-command-label' },
		orderBy: { createdAt: 'desc' },
	});
	assert.ok(staleRow, 'expected the seeding call to have created a shell-command-label row');
	await testPrisma.checkerActivation.update({
		where: { id: staleRow.id },
		data: { checkerId: 'old-removed-checker-id' },
	});

	const refreshFake = makeFakeAnthropic({
		'commit-gating': true,
		'format-before-commit': true,
		'shell-command-label': true,
		'boundary-compact': false,
	});
	const result = await getActivationMap(rulebook, {
		prisma: testPrisma,
		anthropic: refreshFake.client,
	});

	assert.equal(
		refreshFake.calls(),
		1,
		'a stale checker id must not be mistaken for a complete cache',
	);
	assert.equal(result['shell-command-label'], true);
});

test('two concurrent calls for the same uncached rulebook only call Haiku once', async () => {
	await testPrisma.auditRunCall.deleteMany();
	const rulebook = makeRulebook('Rulebook F: concurrency dedup test.');
	const fake = makeFakeAnthropic({
		'commit-gating': true,
		'format-before-commit': true,
		'shell-command-label': true,
		'boundary-compact': false,
	});

	const [first, second] = await Promise.all([
		getActivationMap(rulebook, { prisma: testPrisma, anthropic: fake.client }),
		getActivationMap(rulebook, { prisma: testPrisma, anthropic: fake.client }),
	]);

	assert.deepEqual(first, second);
	assert.equal(
		fake.calls(),
		1,
		'concurrent calls for the same rulebook must share one Haiku call',
	);
	assert.equal(
		await testPrisma.auditRunCall.count(),
		1,
		'one shared call means one billed row — dedup must prevent double-logging too',
	);
});
