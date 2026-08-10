import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import express from 'express';
import { AuditedSessionStatus, PrismaClient } from '../../generated/prisma/index.js';
import { createSessionsRouter } from '../sessions.js';

let testPrisma: PrismaClient;
let tempDir: string;
let server: Server;
let baseUrl: string;

const SLUG = 'demo-project';
const CLEAN_SESSION = 'clean-session';
const DIRTY_SESSION = 'dirty-session';

// Dispatches on the requested tool name: the sessions router drives both activation (Haiku) and
// judgment (configured model) through one client, plus the free count_tokens endpoint.
function makeFakeAnthropic() {
	let createCalls = 0;
	let countTokensCalls = 0;
	return {
		client: {
			messages: {
				async create(params: { tools: Array<{ name: string }> }) {
					createCalls++;
					const toolName = params.tools[0].name;
					if (toolName === 'report_activation') {
						return {
							content: [
								{
									type: 'tool_use',
									id: 'tu_activation',
									name: 'report_activation',
									input: {
										'commit-gating': true,
										'format-before-commit': false,
										'shell-command-label': false,
										'boundary-compact': false,
									},
								},
							],
							usage: {
								input_tokens: 100,
								output_tokens: 20,
								cache_read_input_tokens: 0,
								cache_creation_input_tokens: 0,
							},
						};
					}
					return {
						content: [
							{
								type: 'tool_use',
								id: 'tu_judgment',
								name: 'report_judgment_findings',
								input: {
									ruleRewriteProposals: [],
									complianceNotes: [
										{
											evidence: 'commit made without approval',
											ruleRef: 'general',
											outcome: 'violation',
										},
									],
									environmentalInstructionIgnoredNotes: [],
									promptCoachingNotes: [],
								},
							},
						],
						usage: {
							input_tokens: 4000,
							output_tokens: 200,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					};
				},
				async countTokens() {
					countTokensCalls++;
					return { input_tokens: 5000 };
				},
			},
		},
		createCalls: () => createCalls,
		countTokensCalls: () => countTokensCalls,
	};
}

let fake: ReturnType<typeof makeFakeAnthropic>;

function assistantToolCallRecord(command: string): string {
	return JSON.stringify({
		type: 'assistant',
		message: {
			id: 'msg_1',
			model: 'claude-sonnet-5',
			role: 'assistant',
			content: [
				{
					type: 'tool_use',
					id: 'toolu_1',
					name: 'Bash',
					input: { command },
				},
			],
			usage: { input_tokens: 50, output_tokens: 10 },
		},
		uuid: 'a1',
		timestamp: '2026-07-20T10:00:01.000Z',
		cwd: 'C:\\Users\\user\\Documents\\GitHub\\demo-project',
	});
}

function toolResultRecord(): string {
	return JSON.stringify({
		type: 'user',
		message: {
			role: 'user',
			content: [
				{
					type: 'tool_result',
					tool_use_id: 'toolu_1',
					content: [{ type: 'text', text: 'ok' }],
				},
			],
		},
		uuid: 'u2',
		timestamp: '2026-07-20T10:00:02.000Z',
	});
}

before(async () => {
	tempDir = await mkdtemp(path.join(os.tmpdir(), 'second-flow-sessions-route-test-'));
	const databaseUrl = `file:${path.join(tempDir, 'test.db')}`;
	// No --accept-data-loss: the temp DB is always freshly created and empty, so there is never
	// data to lose — and passing that flag trips Prisma's AI-agent destructive-action gate even
	// against a throwaway file with nothing in it.
	execSync(`npx prisma db push --url "${databaseUrl}"`, { stdio: 'ignore' });
	const adapter = new PrismaLibSql({ url: databaseUrl });
	testPrisma = new PrismaClient({ adapter });

	// Fixture projects root — safe to mutate the env var: node's test runner gives each test file
	// its own process (parser/__tests__/index.test.ts relies on the same isolation).
	const projectsRoot = path.join(tempDir, 'projects');
	process.env.CLAUDE_PROJECTS_DIR = projectsRoot;
	const slugDir = path.join(projectsRoot, SLUG);
	await mkdir(slugDir, { recursive: true });

	const userRecord = JSON.stringify({
		type: 'user',
		message: { role: 'user', content: 'hello, just chatting' },
		uuid: 'u1',
		timestamp: '2026-07-20T10:00:00.000Z',
		cwd: 'C:\\Users\\user\\Documents\\GitHub\\demo-project',
	});
	// Clean: one user message, nothing the gate could trigger on.
	await writeFile(path.join(slugDir, `${CLEAN_SESSION}.jsonl`), `${userRecord}\n`);
	// Dirty: a git commit with zero user turns anywhere before it — the commit-gating checker's
	// provable "no approval turn existed" case (a user message before the commit would read as a
	// possible approval and correctly produce no finding).
	await writeFile(
		path.join(slugDir, `${DIRTY_SESSION}.jsonl`),
		`${assistantToolCallRecord('git commit -m "x"')}\n${toolResultRecord()}\n`,
	);

	// Fixture home dir so the global-rulebook discovery never reads the real ~/.claude/CLAUDE.md.
	const homeDir = path.join(tempDir, 'home');
	await mkdir(path.join(homeDir, '.claude'), { recursive: true });
	await writeFile(
		path.join(homeDir, '.claude', 'CLAUDE.md'),
		'Never commit without explicit user approval of the message.\n',
	);

	fake = makeFakeAnthropic();
	const app = express();
	app.use(express.json());
	app.use(
		'/api',
		createSessionsRouter({
			prisma: testPrisma,
			anthropic: fake.client,
			rulebookOpts: { homeDir },
		}),
	);
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

test('GET /api/projects lists slugs with session counts, most recent first', async () => {
	const res = await fetch(`${baseUrl}/api/projects`);
	assert.equal(res.status, 200);
	const body = (await res.json()) as {
		projects: Array<{
			slug: string;
			sessionCount: number;
			latestSessionMtime: string;
			cwd: string | null;
		}>;
	};
	const project = body.projects.find((entry) => entry.slug === SLUG);
	assert.ok(project, 'the fixture project must be listed');
	assert.equal(project.sessionCount, 2);
	assert.ok(project.latestSessionMtime);
	assert.equal(
		project.cwd,
		'C:\\Users\\user\\Documents\\GitHub\\demo-project',
		'the real cwd peeked from the latest transcript, not the lossy slug',
	);
});

test('GET /api/projects/:slug/sessions lists transcripts with null audit state when unaudited', async () => {
	const res = await fetch(`${baseUrl}/api/projects/${SLUG}/sessions`);
	assert.equal(res.status, 200);
	const body = (await res.json()) as {
		sessions: Array<{ sessionId: string; fileSize: number; audit: unknown }>;
	};
	assert.equal(body.sessions.length, 2);
	for (const session of body.sessions) {
		assert.equal(session.audit, null);
		assert.ok(session.fileSize > 0);
	}
});

test('GET /api/projects/:slug/sessions is 404 for an unknown slug', async () => {
	const res = await fetch(`${baseUrl}/api/projects/no-such-slug/sessions`);
	assert.equal(res.status, 404);
});

test('GET /api/projects/:slug/sessions does not mask a non-ENOENT error as a false 404', async () => {
	// %5C decodes to a literal backslash in req.params.slug — a plain "." / ".." segment gets
	// collapsed by URL normalization before the request is even sent, but a backslash survives,
	// still tripping locate.ts's path-traversal guard. That's a non-ENOENT error and must not be
	// silently reported as "no project directory found".
	const res = await fetch(`${baseUrl}/api/projects/a%5Cb/sessions`);
	assert.equal(res.status, 500);
});

test('preview on a clean session waves through, free: no create call, no count_tokens call', async () => {
	const createCallsBefore = fake.createCalls();
	const countBefore = fake.countTokensCalls();

	const res = await fetch(`${baseUrl}/api/projects/${SLUG}/sessions/${CLEAN_SESSION}/preview`, {
		method: 'POST',
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as { gate: string };
	assert.equal(body.gate, 'wavedThrough');
	assert.equal(
		fake.countTokensCalls(),
		countBefore,
		'no estimate needed for a waved-through session',
	);
	// The one allowed spend is activation classification on first sight of the rulebook — cached
	// afterward; a judgment call must never happen in preview.
	assert.ok(fake.createCalls() - createCallsBefore <= 1);

	const sessions = await testPrisma.auditedSession.findMany();
	assert.equal(sessions.length, 0, 'preview must never write history');
});

test('preview on a triggered session returns trigger summary and a priced token estimate', async () => {
	const res = await fetch(`${baseUrl}/api/projects/${SLUG}/sessions/${DIRTY_SESSION}/preview`, {
		method: 'POST',
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as {
		gate: string;
		model: string;
		triggers: Array<{ kind: string; count: number }>;
		estimate: {
			inputTokens: number;
			inputCostUsd: number;
			maxOutputTokens: number;
			maxTotalCostUsd: number;
		} | null;
	};
	assert.equal(body.gate, 'triggered');
	assert.equal(body.model, 'claude-sonnet-5');
	assert.deepEqual(body.triggers, [{ kind: 'lint-finding', count: 1 }]);
	assert.ok(body.estimate, 'a triggered preview must carry an estimate');
	assert.equal(body.estimate.inputTokens, 5000);
	// 5000 input tokens at $2/MTok, plus 8192 max output at $10/MTok.
	assert.ok(Math.abs(body.estimate.inputCostUsd - 0.01) < 1e-9);
	assert.ok(Math.abs(body.estimate.maxTotalCostUsd - (0.01 + 0.08192)) < 1e-9);
});

test('preview is 404 for a transcript that does not exist', async () => {
	const res = await fetch(`${baseUrl}/api/projects/${SLUG}/sessions/no-such-session/preview`, {
		method: 'POST',
	});
	assert.equal(res.status, 404);
});

test('audit of a clean session persists a wavedThrough row with file stat and zero counts', async () => {
	const res = await fetch(`${baseUrl}/api/projects/${SLUG}/sessions/${CLEAN_SESSION}/audit`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({}),
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as { outcome: string; auditedSessionId: string };
	assert.equal(body.outcome, 'wavedThrough');

	const row = await testPrisma.auditedSession.findUniqueOrThrow({
		where: { id: body.auditedSessionId },
	});
	assert.equal(row.status, AuditedSessionStatus.wavedThrough);
	assert.equal(row.proposalsCreated, 0);
	assert.equal(row.notesCreated, 0);
	assert.ok(row.transcriptFileSize !== null && row.transcriptFileSize > 0);
	assert.ok(row.transcriptFileMtime !== null);

	const run = await testPrisma.auditRun.findUniqueOrThrow({ where: { id: row.auditRunId } });
	assert.ok(run.completedAt !== null, 'the audit run must be completed even on the free path');
});

test('audit of a triggered session runs judgment and persists findings with counts', async () => {
	const res = await fetch(`${baseUrl}/api/projects/${SLUG}/sessions/${DIRTY_SESSION}/audit`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({}),
	});
	assert.equal(res.status, 200);
	const body = (await res.json()) as {
		outcome: string;
		auditedSessionId: string;
		proposalsCreated: number;
		notesCreated: number;
	};
	assert.equal(body.outcome, 'completed');
	assert.equal(body.proposalsCreated, 0);
	assert.equal(body.notesCreated, 1);

	const row = await testPrisma.auditedSession.findUniqueOrThrow({
		where: { id: body.auditedSessionId },
	});
	assert.equal(row.status, AuditedSessionStatus.completed);
	assert.equal(row.notesCreated, 1);
	assert.ok(row.transcriptFileSize !== null);

	const notes = await testPrisma.analysisNote.findMany({
		where: { auditedSessionId: body.auditedSessionId },
	});
	assert.equal(notes.length, 1);
	assert.equal(notes[0].ruleRef, 'general');

	const calls = await testPrisma.auditRunCall.findMany({ where: { purpose: 'judgment' } });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].model, 'claude-sonnet-5');
});

test('two concurrent audit requests for the same session never both bill — one wins, one gets a 409', async () => {
	const [first, second] = await Promise.all([
		fetch(`${baseUrl}/api/projects/${SLUG}/sessions/${CLEAN_SESSION}/audit`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({}),
		}),
		fetch(`${baseUrl}/api/projects/${SLUG}/sessions/${CLEAN_SESSION}/audit`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({}),
		}),
	]);
	const statuses = [first.status, second.status].sort();
	assert.deepEqual(statuses, [200, 409], 'exactly one request should succeed');

	const rows = await testPrisma.auditedSession.findMany({
		where: { transcriptSessionId: CLEAN_SESSION },
	});
	assert.equal(rows.length, 1, 'the race must never produce two AuditedSession rows');
});

test('re-auditing without force is a 409 carrying the existing audit; force re-audits', async () => {
	const first = await fetch(`${baseUrl}/api/projects/${SLUG}/sessions/${CLEAN_SESSION}/audit`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({}),
	});
	assert.equal(first.status, 200);

	const blocked = await fetch(`${baseUrl}/api/projects/${SLUG}/sessions/${CLEAN_SESSION}/audit`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({}),
	});
	assert.equal(blocked.status, 409);
	const blockedBody = (await blocked.json()) as {
		existing: { auditedSessionId: string; status: string };
	};
	assert.equal(blockedBody.existing.status, 'wavedThrough');

	const forced = await fetch(`${baseUrl}/api/projects/${SLUG}/sessions/${CLEAN_SESSION}/audit`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ force: true }),
	});
	assert.equal(forced.status, 200);
	const rows = await testPrisma.auditedSession.findMany({
		where: { transcriptSessionId: CLEAN_SESSION },
	});
	assert.equal(rows.length, 2, 'a forced re-audit creates a second history row');
});

test('the session list joins the latest audit with status and changedSinceAudit false', async () => {
	const audit = await fetch(`${baseUrl}/api/projects/${SLUG}/sessions/${CLEAN_SESSION}/audit`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({}),
	});
	assert.equal(audit.status, 200);

	const res = await fetch(`${baseUrl}/api/projects/${SLUG}/sessions`);
	const body = (await res.json()) as {
		sessions: Array<{
			sessionId: string;
			audit: { status: string; changedSinceAudit: boolean | null; auditCount: number } | null;
		}>;
	};
	const clean = body.sessions.find((session) => session.sessionId === CLEAN_SESSION);
	assert.ok(clean?.audit);
	assert.equal(clean.audit.status, 'wavedThrough');
	assert.equal(clean.audit.changedSinceAudit, false);
	assert.equal(clean.audit.auditCount, 1);
	const dirty = body.sessions.find((session) => session.sessionId === DIRTY_SESSION);
	assert.equal(dirty?.audit, null, 'the unaudited session stays unaudited');
});

test('GET /api/sessions/:auditedSessionId returns stored findings grouped by kind', async () => {
	const audit = await fetch(`${baseUrl}/api/projects/${SLUG}/sessions/${DIRTY_SESSION}/audit`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({}),
	});
	const { auditedSessionId } = (await audit.json()) as { auditedSessionId: string };

	const res = await fetch(`${baseUrl}/api/sessions/${auditedSessionId}`);
	assert.equal(res.status, 200);
	const body = (await res.json()) as {
		auditedSession: { status: string; transcriptSessionId: string };
		proposals: unknown[];
		notesByKind: { compliance: Array<{ ruleRef: string; recurrence: unknown }> };
	};
	assert.equal(body.auditedSession.transcriptSessionId, DIRTY_SESSION);
	assert.equal(body.proposals.length, 0);
	assert.equal(body.notesByKind.compliance.length, 1);
	assert.equal(body.notesByKind.compliance[0].ruleRef, 'general');
	assert.ok(
		'recurrence' in body.notesByKind.compliance[0],
		'each note carries its recurrence marker (null when there are no later audits)',
	);
});

test('GET /api/sessions/:auditedSessionId is 404 for an unknown id', async () => {
	const res = await fetch(`${baseUrl}/api/sessions/nonexistent-id`);
	assert.equal(res.status, 404);
});

test('GET /api/sessions/:auditedSessionId includes every audit of the same transcript as history, newest first', async () => {
	const first = await fetch(`${baseUrl}/api/projects/${SLUG}/sessions/${DIRTY_SESSION}/audit`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({}),
	});
	const { auditedSessionId: firstId } = (await first.json()) as { auditedSessionId: string };

	const second = await fetch(`${baseUrl}/api/projects/${SLUG}/sessions/${DIRTY_SESSION}/audit`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ force: true }),
	});
	const { auditedSessionId: secondId } = (await second.json()) as { auditedSessionId: string };

	const res = await fetch(`${baseUrl}/api/sessions/${firstId}`);
	const body = (await res.json()) as {
		history: Array<{
			auditedSessionId: string;
			status: string;
			model: string | null;
			costUsd: number | null;
			inputTokens: number | null;
			outputTokens: number | null;
			isCurrent: boolean;
		}>;
	};
	assert.equal(body.history.length, 2);
	assert.equal(body.history[0].auditedSessionId, secondId, 'newest audit first');
	assert.equal(body.history[1].auditedSessionId, firstId);
	for (const entry of body.history) {
		assert.equal(entry.status, 'completed');
		assert.equal(entry.model, 'claude-sonnet-5');
		// Fake judgment usage is 4000 input / 200 output tokens at sonnet's $2/$10 per MTok rate.
		assert.equal(entry.costUsd, 0.01, 'costUsd must reflect the real judgment call usage');
		assert.equal(entry.inputTokens, 4000);
		assert.equal(entry.outputTokens, 200);
	}
	assert.equal(body.history[0].isCurrent, false, 'isCurrent tracks the URL param, not recency');
	assert.equal(body.history[1].isCurrent, true);
});

test('GET /api/sessions/:auditedSessionId reports a single-entry history with a null model for a wavedThrough audit', async () => {
	const audit = await fetch(`${baseUrl}/api/projects/${SLUG}/sessions/${CLEAN_SESSION}/audit`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({}),
	});
	const { auditedSessionId } = (await audit.json()) as { auditedSessionId: string };

	const res = await fetch(`${baseUrl}/api/sessions/${auditedSessionId}`);
	const body = (await res.json()) as {
		history: Array<{
			auditedSessionId: string;
			model: string | null;
			costUsd: number | null;
			inputTokens: number | null;
			outputTokens: number | null;
			isCurrent: boolean;
		}>;
	};
	assert.equal(body.history.length, 1);
	assert.equal(body.history[0].auditedSessionId, auditedSessionId);
	assert.equal(body.history[0].model, null);
	assert.equal(body.history[0].costUsd, null, 'no judgment call ran, so there is no cost');
	assert.equal(body.history[0].inputTokens, null);
	assert.equal(body.history[0].outputTokens, null);
	assert.equal(body.history[0].isCurrent, true);
});
