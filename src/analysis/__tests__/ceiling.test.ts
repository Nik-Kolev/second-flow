import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { PrismaClient } from '../../generated/prisma/index.js';
import { checkCeiling, confirmJudgmentBatch } from '../ceiling.js';
import { JUDGMENT_PURPOSE } from '../judgment.js';

let testPrisma: PrismaClient;
let tempDir: string;

before(async () => {
	tempDir = await mkdtemp(path.join(os.tmpdir(), 'second-flow-ceiling-test-'));
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
	await testPrisma.auditRun.deleteMany();
});

async function seedJudgmentCalls(auditRunId: string, count: number): Promise<void> {
	for (let i = 0; i < count; i++) {
		await testPrisma.auditRunCall.create({
			data: {
				auditRunId,
				model: 'claude-sonnet-5',
				purpose: JUDGMENT_PURPOSE,
				inputTokens: 1,
				outputTokens: 1,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
			},
		});
	}
}

test('checkCeiling returns ok when under the configured max', async () => {
	const auditRun = await testPrisma.auditRun.create({ data: {} });
	await seedJudgmentCalls(auditRun.id, 2);

	const result = await checkCeiling(auditRun.id, { prisma: testPrisma, maxSonnetCalls: 5 });

	assert.equal(result, 'ok');
});

test('checkCeiling returns ceilingExceeded at or over the configured max', async () => {
	const auditRun = await testPrisma.auditRun.create({ data: {} });
	await seedJudgmentCalls(auditRun.id, 5);

	const result = await checkCeiling(auditRun.id, { prisma: testPrisma, maxSonnetCalls: 5 });

	assert.equal(result, 'ceilingExceeded');
});

test('checkCeiling only counts calls with purpose "judgment", not other purposes on the same run', async () => {
	const auditRun = await testPrisma.auditRun.create({ data: {} });
	await testPrisma.auditRunCall.create({
		data: {
			auditRunId: auditRun.id,
			model: 'claude-haiku-4-5',
			purpose: 'reconciliation',
			inputTokens: 1,
			outputTokens: 1,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
		},
	});

	const result = await checkCeiling(auditRun.id, { prisma: testPrisma, maxSonnetCalls: 1 });

	assert.equal(result, 'ok', 'a reconciliation call must not count toward the judgment ceiling');
});

test('checkCeiling uses the default max when none is configured', async () => {
	const auditRun = await testPrisma.auditRun.create({ data: {} });
	await seedJudgmentCalls(auditRun.id, 1);

	const result = await checkCeiling(auditRun.id, { prisma: testPrisma });

	assert.equal(result, 'ok');
});

test('confirmJudgmentBatch never calls confirmBatch when gatedCount is zero', async () => {
	let called = false;
	const result = await confirmJudgmentBatch(0, async () => {
		called = true;
		return true;
	});

	assert.equal(result, false);
	assert.equal(called, false);
});

test('confirmJudgmentBatch calls confirmBatch exactly once and returns its resolved value', async () => {
	let callCount = 0;
	const result = await confirmJudgmentBatch(3, async () => {
		callCount++;
		return true;
	});

	assert.equal(result, true);
	assert.equal(callCount, 1);
});

test('confirmJudgmentBatch propagates a declined confirmation', async () => {
	const result = await confirmJudgmentBatch(1, async () => false);

	assert.equal(result, false);
});
