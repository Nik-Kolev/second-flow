import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import express from 'express';
import { PrismaClient } from '../../generated/prisma/index.js';
import { createDashboardRouter } from '../dashboard.js';

let testPrisma: PrismaClient;
let tempDir: string;
let server: Server;
let baseUrl: string;

before(async () => {
	tempDir = await mkdtemp(path.join(os.tmpdir(), 'second-flow-dashboard-route-test-'));
	const databaseUrl = `file:${path.join(tempDir, 'test.db')}`;
	// No --accept-data-loss: the temp DB is always freshly created and empty, so there is never
	// data to lose — and passing that flag trips Prisma's AI-agent destructive-action gate even
	// against a throwaway file with nothing in it.
	execSync(`npx prisma db push --url "${databaseUrl}"`, { stdio: 'ignore' });
	const adapter = new PrismaLibSql({ url: databaseUrl });
	testPrisma = new PrismaClient({ adapter });

	const app = express();
	app.use(express.json());
	app.use('/api', createDashboardRouter({ prisma: testPrisma }));
	server = app.listen(0);
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new Error('expected the test server to bind a numeric port');
	}
	baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
	server.close();
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
	await testPrisma.auditSettings.deleteMany();
});

test('GET /api/dashboard carries stats and settings alongside the legacy keys', async () => {
	const res = await fetch(`${baseUrl}/api/dashboard`);
	assert.equal(res.status, 200);
	const body = (await res.json()) as {
		overview: { totalSpendUsd: number };
		proposals: unknown[];
		notesByKind: Record<string, unknown[]>;
		stats: {
			totalSpendUsd: number;
			sessionsAudited: number;
			openProposalCount: number;
			noteCount: number;
		};
		settings: {
			judgmentModel: string;
			maxSonnetCallsPerRun: number;
			models: Array<{ id: string; pricing: { input: number; output: number } | null }>;
		};
	};
	assert.ok(body.overview, 'legacy overview key must survive until the UI rebuild lands');
	assert.ok(body.notesByKind);
	assert.equal(body.stats.sessionsAudited, 0);
	assert.equal(body.settings.judgmentModel, 'claude-sonnet-5');
	assert.equal(body.settings.maxSonnetCallsPerRun, 10);
	assert.equal(body.settings.models.length, 3);
	for (const model of body.settings.models) {
		assert.ok(model.pricing, `model ${model.id} must ship its pricing for the picker UI`);
	}
});

test('PUT /api/dashboard/settings updates the judgment model against the allowlist', async () => {
	const res = await fetch(`${baseUrl}/api/dashboard/settings`, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ judgmentModel: 'claude-opus-5' }),
	});
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { judgmentModel: 'claude-opus-5' });

	const settings = await testPrisma.auditSettings.findFirst();
	assert.equal(settings?.judgmentModel, 'claude-opus-5');
});

test('PUT /api/dashboard/settings rejects a model outside the allowlist', async () => {
	for (const bad of ['claude-haiku-4-5', 'gpt-4', 42, null, undefined]) {
		const res = await fetch(`${baseUrl}/api/dashboard/settings`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ judgmentModel: bad }),
		});
		assert.equal(res.status, 400, `"${String(bad)}" must be rejected`);
	}
	const settings = await testPrisma.auditSettings.findFirst();
	assert.equal(settings, null, 'a rejected update must not create or touch the settings row');
});

test('PUT /api/dashboard/ceiling still works after the settings reshape', async () => {
	const res = await fetch(`${baseUrl}/api/dashboard/ceiling`, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ maxSonnetCallsPerRun: 3 }),
	});
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { maxSonnetCallsPerRun: 3 });
});
