import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { PrismaClient } from '../../generated/prisma/index.js';
import {
	getAuditSettings,
	isJudgmentModel,
	JUDGMENT_MODELS,
	updateJudgmentModel,
} from '../settings.js';
import { PRICING_PER_MTOK } from '../../dashboard/pricing.js';

let testPrisma: PrismaClient;
let tempDir: string;

before(async () => {
	tempDir = await mkdtemp(path.join(os.tmpdir(), 'second-flow-settings-test-'));
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
	await testPrisma.auditSettings.deleteMany();
});

test('the lazily-created settings row seeds judgmentModel with the Sonnet default', async () => {
	const settings = await getAuditSettings({ prisma: testPrisma });
	assert.equal(settings.judgmentModel, 'claude-sonnet-5');
});

test('updateJudgmentModel persists and reads back without a restart', async () => {
	await updateJudgmentModel('claude-fable-5', { prisma: testPrisma });
	const settings = await getAuditSettings({ prisma: testPrisma });
	assert.equal(settings.judgmentModel, 'claude-fable-5');
});

test('isJudgmentModel accepts exactly the allowlist and rejects everything else', () => {
	for (const model of JUDGMENT_MODELS) {
		assert.equal(isJudgmentModel(model), true);
	}
	assert.equal(isJudgmentModel('claude-haiku-4-5'), false, 'Haiku is not a judgment model');
	assert.equal(isJudgmentModel('gpt-4'), false);
	assert.equal(isJudgmentModel(''), false);
	assert.equal(isJudgmentModel(undefined), false);
	assert.equal(isJudgmentModel(42), false);
});

test('every judgment model in the allowlist has a pricing entry on the spend meter', () => {
	for (const model of JUDGMENT_MODELS) {
		assert.ok(
			PRICING_PER_MTOK[model],
			`"${model}" is selectable but has no pricing row — its spend would count as $0`,
		);
	}
});
