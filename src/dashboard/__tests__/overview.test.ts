import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { JUDGMENT_PURPOSE } from '../../analysis/judgment.js';
import { AuditedSessionStatus, PrismaClient } from '../../generated/prisma/index.js';
import { getDashboardOverview } from '../overview.js';

let testPrisma: PrismaClient;
let tempDir: string;

before(async () => {
	tempDir = await mkdtemp(path.join(os.tmpdir(), 'second-flow-overview-test-'));
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
	await testPrisma.auditSettings.deleteMany();
});

test('getDashboardOverview resolves the in-progress run over a completed one when both exist', async () => {
	await testPrisma.auditRun.create({ data: { completedAt: new Date() } });
	const inProgress = await testPrisma.auditRun.create({ data: {} });

	const overview = await getDashboardOverview({ prisma: testPrisma });

	assert.equal(overview.ceiling.runId, inProgress.id);
	assert.equal(overview.ceiling.runInProgress, true);
});

test('getDashboardOverview falls back to the most recently completed run when nothing is in progress', async () => {
	await testPrisma.auditRun.create({ data: { completedAt: new Date('2020-01-01') } });
	const recent = await testPrisma.auditRun.create({
		data: { completedAt: new Date('2020-06-01') },
	});

	const overview = await getDashboardOverview({ prisma: testPrisma });

	assert.equal(overview.ceiling.runId, recent.id);
	assert.equal(overview.ceiling.runInProgress, false);
});

test('getDashboardOverview reports a capped run when it has skippedCeiling sessions', async () => {
	const run = await testPrisma.auditRun.create({ data: {} });
	await testPrisma.auditedSession.create({
		data: {
			transcriptSessionId: 's1',
			projectSlug: 'proj',
			auditRunId: run.id,
			status: AuditedSessionStatus.skippedCeiling,
		},
	});

	const overview = await getDashboardOverview({ prisma: testPrisma });

	assert.equal(overview.cappedRun.isCapped, true);
	assert.equal(overview.cappedRun.skippedSessionCount, 1);
});

test('getDashboardOverview reports no capped run when every session completed normally', async () => {
	const run = await testPrisma.auditRun.create({ data: {} });
	await testPrisma.auditedSession.create({
		data: {
			transcriptSessionId: 's1',
			projectSlug: 'proj',
			auditRunId: run.id,
			status: AuditedSessionStatus.completed,
		},
	});

	const overview = await getDashboardOverview({ prisma: testPrisma });

	assert.equal(overview.cappedRun.isCapped, false);
	assert.equal(overview.cappedRun.skippedSessionCount, 0);
});

test('getDashboardOverview sums transcriptTokenTotal across sessions, treating null as 0', async () => {
	const run = await testPrisma.auditRun.create({ data: {} });
	await testPrisma.auditedSession.create({
		data: {
			transcriptSessionId: 's1',
			projectSlug: 'proj',
			auditRunId: run.id,
			status: AuditedSessionStatus.completed,
			transcriptTokenTotal: 500,
		},
	});
	await testPrisma.auditedSession.create({
		data: {
			transcriptSessionId: 's2',
			projectSlug: 'proj',
			auditRunId: run.id,
			status: AuditedSessionStatus.completed,
		},
	});

	const overview = await getDashboardOverview({ prisma: testPrisma });

	assert.equal(overview.transcriptTokenTotal, 500);
});

test('getDashboardOverview sums spend from AuditRunCall rows via the pricing table', async () => {
	const run = await testPrisma.auditRun.create({ data: {} });
	await testPrisma.auditRunCall.create({
		data: {
			auditRunId: run.id,
			model: 'claude-haiku-4-5',
			purpose: JUDGMENT_PURPOSE,
			inputTokens: 1_000_000,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
		},
	});

	const overview = await getDashboardOverview({ prisma: testPrisma });

	assert.ok(overview.totalSpendUsd > 0);
});
