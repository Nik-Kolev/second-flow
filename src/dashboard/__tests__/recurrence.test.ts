import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import {
	AnalysisNoteKind,
	AuditedSessionStatus,
	PrismaClient,
} from '../../generated/prisma/index.js';
import { getNoteRecurrenceForSession } from '../recurrence.js';

let testPrisma: PrismaClient;
let tempDir: string;

before(async () => {
	tempDir = await mkdtemp(path.join(os.tmpdir(), 'second-flow-recurrence-test-'));
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

// Recurrence scans whole tables (later audits, notes by ruleRef) with no per-test scoping key —
// each test needs a clean slate, same reasoning as ledger.test.ts.
beforeEach(async () => {
	await testPrisma.analysisNote.deleteMany();
	await testPrisma.auditedSession.deleteMany();
	await testPrisma.auditRun.deleteMany();
});

interface SeedAuditOptions {
	transcriptSessionId: string;
	createdAt: Date;
	status?: AuditedSessionStatus;
	noteRuleRefs?: Array<string | null>;
}

async function seedAudit(options: SeedAuditOptions): Promise<string> {
	const auditRun = await testPrisma.auditRun.create({ data: {} });
	const session = await testPrisma.auditedSession.create({
		data: {
			transcriptSessionId: options.transcriptSessionId,
			projectSlug: 'fixture-project',
			auditRunId: auditRun.id,
			status: options.status ?? AuditedSessionStatus.completed,
			createdAt: options.createdAt,
		},
	});
	for (const ruleRef of options.noteRuleRefs ?? []) {
		await testPrisma.analysisNote.create({
			data: {
				auditedSessionId: session.id,
				kind: AnalysisNoteKind.compliance,
				evidence: `evidence for ${ruleRef ?? 'legacy'}`,
				ruleRef,
			},
		});
	}
	return session.id;
}

const T1 = new Date('2026-07-01T10:00:00.000Z');
const T2 = new Date('2026-07-02T10:00:00.000Z');
const T3 = new Date('2026-07-03T10:00:00.000Z');

test('a ruleRef reported again by a later completed audit is marked recurred', async () => {
	const earlyId = await seedAudit({
		transcriptSessionId: 'session-a',
		createdAt: T1,
		noteRuleRefs: ['CLAUDE.md'],
	});
	await seedAudit({
		transcriptSessionId: 'session-b',
		createdAt: T2,
		noteRuleRefs: ['CLAUDE.md'],
	});
	await seedAudit({ transcriptSessionId: 'session-c', createdAt: T3, noteRuleRefs: [] });

	const markers = await getNoteRecurrenceForSession(earlyId, { prisma: testPrisma });

	assert.deepEqual(markers['CLAUDE.md'], {
		kind: 'recurred',
		laterAuditCount: 2,
		recurredInCount: 1,
	});
});

test('a ruleRef no later audit reports is marked notSeenSince with the later-audit count', async () => {
	const earlyId = await seedAudit({
		transcriptSessionId: 'session-a',
		createdAt: T1,
		noteRuleRefs: ['CLAUDE.md'],
	});
	await seedAudit({ transcriptSessionId: 'session-b', createdAt: T2, noteRuleRefs: ['general'] });
	await seedAudit({ transcriptSessionId: 'session-c', createdAt: T3, noteRuleRefs: [] });

	const markers = await getNoteRecurrenceForSession(earlyId, { prisma: testPrisma });

	assert.deepEqual(markers['CLAUDE.md'], { kind: 'notSeenSince', laterAuditCount: 2 });
});

test('wavedThrough and errored later audits do not count — their silence proves nothing', async () => {
	const earlyId = await seedAudit({
		transcriptSessionId: 'session-a',
		createdAt: T1,
		noteRuleRefs: ['CLAUDE.md'],
	});
	await seedAudit({
		transcriptSessionId: 'session-b',
		createdAt: T2,
		status: AuditedSessionStatus.wavedThrough,
	});
	await seedAudit({
		transcriptSessionId: 'session-c',
		createdAt: T3,
		status: AuditedSessionStatus.errored,
	});

	const markers = await getNoteRecurrenceForSession(earlyId, { prisma: testPrisma });

	assert.deepEqual(
		markers['CLAUDE.md'],
		{ kind: 'notSeenSince', laterAuditCount: 0 },
		'audits that never ran a judgment pass must not inflate the not-seen-since count',
	);
});

test('a later re-audit of the same transcript is not a new occurrence', async () => {
	const earlyId = await seedAudit({
		transcriptSessionId: 'session-a',
		createdAt: T1,
		noteRuleRefs: ['CLAUDE.md'],
	});
	// Forced re-audit of the same session, same finding — same mistake, not a recurrence.
	await seedAudit({
		transcriptSessionId: 'session-a',
		createdAt: T2,
		noteRuleRefs: ['CLAUDE.md'],
	});

	const markers = await getNoteRecurrenceForSession(earlyId, { prisma: testPrisma });

	assert.deepEqual(markers['CLAUDE.md'], { kind: 'notSeenSince', laterAuditCount: 0 });
});

test('legacy null-ruleRef notes get no marker at all', async () => {
	const earlyId = await seedAudit({
		transcriptSessionId: 'session-a',
		createdAt: T1,
		noteRuleRefs: [null],
	});
	await seedAudit({
		transcriptSessionId: 'session-b',
		createdAt: T2,
		noteRuleRefs: ['CLAUDE.md'],
	});

	const markers = await getNoteRecurrenceForSession(earlyId, { prisma: testPrisma });

	assert.deepEqual(markers, {}, 'null has no string identity to match on — no marker, ever');
});

test('markers are computed per ruleRef independently within one session', async () => {
	const earlyId = await seedAudit({
		transcriptSessionId: 'session-a',
		createdAt: T1,
		noteRuleRefs: ['CLAUDE.md', 'general'],
	});
	await seedAudit({ transcriptSessionId: 'session-b', createdAt: T2, noteRuleRefs: ['general'] });

	const markers = await getNoteRecurrenceForSession(earlyId, { prisma: testPrisma });

	assert.deepEqual(markers['CLAUDE.md'], { kind: 'notSeenSince', laterAuditCount: 1 });
	assert.deepEqual(markers['general'], {
		kind: 'recurred',
		laterAuditCount: 1,
		recurredInCount: 1,
	});
});
