import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import {
	AuditedSessionStatus,
	PrismaClient,
	RuleProposalStatus,
} from '../../generated/prisma/index.js';
import { getRankedProposalGroups } from '../findings.js';

let testPrisma: PrismaClient;
let tempDir: string;

before(async () => {
	tempDir = await mkdtemp(path.join(os.tmpdir(), 'second-flow-findings-test-'));
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
	await testPrisma.ruleProposal.deleteMany();
	await testPrisma.analysisNote.deleteMany();
	await testPrisma.auditedSession.deleteMany();
	await testPrisma.auditRun.deleteMany();
});

async function seedSession(): Promise<string> {
	const auditRun = await testPrisma.auditRun.create({ data: {} });
	const session = await testPrisma.auditedSession.create({
		data: {
			transcriptSessionId: 'session-1',
			projectSlug: 'proj',
			auditRunId: auditRun.id,
			status: AuditedSessionStatus.completed,
		},
	});
	return session.id;
}

test('getRankedProposalGroups collapses same-session same-ref rows into one group with an occurrence count', async () => {
	const sessionId = await seedSession();
	await testPrisma.ruleProposal.create({
		data: {
			auditedSessionId: sessionId,
			targetRuleRef: 'CLAUDE.md',
			targetTextSnapshot: 'old text',
			proposedText: 'new text A',
			evidence: 'evidence A',
			status: RuleProposalStatus.proposed,
		},
	});
	await testPrisma.ruleProposal.create({
		data: {
			auditedSessionId: sessionId,
			targetRuleRef: 'CLAUDE.md',
			targetTextSnapshot: 'old text',
			proposedText: 'new text B',
			evidence: 'evidence B',
			status: RuleProposalStatus.proposed,
		},
	});

	const groups = await getRankedProposalGroups({ prisma: testPrisma });

	assert.equal(groups.length, 1);
	assert.equal(groups[0]!.occurrenceCount, 2);
	assert.deepEqual(groups[0]!.allEvidence.sort(), ['evidence A', 'evidence B']);
});

test('getRankedProposalGroups does not collapse the same targetRuleRef across different sessions', async () => {
	const sessionA = await seedSession();
	const sessionB = await seedSession();
	for (const sessionId of [sessionA, sessionB]) {
		await testPrisma.ruleProposal.create({
			data: {
				auditedSessionId: sessionId,
				targetRuleRef: 'CLAUDE.md',
				targetTextSnapshot: 'old text',
				proposedText: 'new text',
				evidence: 'evidence',
				status: RuleProposalStatus.proposed,
			},
		});
	}

	const groups = await getRankedProposalGroups({ prisma: testPrisma });

	assert.equal(
		groups.length,
		2,
		'different sessions targeting the same file must stay separate groups',
	);
});

test('getRankedProposalGroups ranks proposed above resolved and dismissed', async () => {
	const sessionId = await seedSession();
	await testPrisma.ruleProposal.create({
		data: {
			auditedSessionId: sessionId,
			targetRuleRef: 'a.md',
			targetTextSnapshot: 'x',
			proposedText: 'x',
			evidence: 'x',
			status: RuleProposalStatus.dismissed,
		},
	});
	await testPrisma.ruleProposal.create({
		data: {
			auditedSessionId: sessionId,
			targetRuleRef: 'b.md',
			targetTextSnapshot: 'x',
			proposedText: 'x',
			evidence: 'x',
			status: RuleProposalStatus.proposed,
		},
	});
	await testPrisma.ruleProposal.create({
		data: {
			auditedSessionId: sessionId,
			targetRuleRef: 'c.md',
			targetTextSnapshot: 'x',
			proposedText: 'x',
			evidence: 'x',
			status: RuleProposalStatus.resolved,
		},
	});

	const groups = await getRankedProposalGroups({ prisma: testPrisma });

	assert.deepEqual(
		groups.map((group) => group.status),
		[RuleProposalStatus.proposed, RuleProposalStatus.resolved, RuleProposalStatus.dismissed],
	);
});

test('getRankedProposalGroups breaks status ties by occurrence count', async () => {
	const sessionId = await seedSession();
	await testPrisma.ruleProposal.create({
		data: {
			auditedSessionId: sessionId,
			targetRuleRef: 'busy.md',
			targetTextSnapshot: 'x',
			proposedText: 'x',
			evidence: 'x',
			status: RuleProposalStatus.proposed,
		},
	});
	await testPrisma.ruleProposal.create({
		data: {
			auditedSessionId: sessionId,
			targetRuleRef: 'busy.md',
			targetTextSnapshot: 'x',
			proposedText: 'x',
			evidence: 'x',
			status: RuleProposalStatus.proposed,
		},
	});
	await testPrisma.ruleProposal.create({
		data: {
			auditedSessionId: sessionId,
			targetRuleRef: 'quiet.md',
			targetTextSnapshot: 'x',
			proposedText: 'x',
			evidence: 'x',
			status: RuleProposalStatus.proposed,
		},
	});

	const groups = await getRankedProposalGroups({ prisma: testPrisma });

	assert.equal(
		groups[0]!.targetRuleRef,
		'busy.md',
		'higher occurrence count should rank first among equal status',
	);
});
