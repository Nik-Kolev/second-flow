import prismaClient from '../lib/prisma.js';
import { JUDGMENT_PURPOSE } from './judgment.js';

export const DEFAULT_MAX_SONNET_CALLS_PER_RUN = 10;

export interface CeilingDeps {
	prisma?: typeof prismaClient;
	maxSonnetCalls?: number;
}

export type CeilingCheckResult = 'ok' | 'ceilingExceeded';

// Queried from the DB (the existing AuditRunCall ledger) rather than an in-memory counter, so
// the ceiling can't desync across process restarts — same DB-is-the-ledger philosophy step 6 set.
export async function checkCeiling(
	auditRunId: string,
	deps: CeilingDeps = {},
): Promise<CeilingCheckResult> {
	const prisma = deps.prisma ?? prismaClient;
	const maxSonnetCalls = deps.maxSonnetCalls ?? DEFAULT_MAX_SONNET_CALLS_PER_RUN;

	const callCount = await prisma.auditRunCall.count({
		where: { auditRunId, purpose: JUDGMENT_PURPOSE },
	});

	return callCount >= maxSonnetCalls ? 'ceilingExceeded' : 'ok';
}

// There is no safe silent default for "should we spend real money" — unlike prisma above,
// confirmBatch is a required parameter everywhere it's used, never defaulted.
export async function confirmJudgmentBatch(
	gatedCount: number,
	confirmBatch: () => Promise<boolean>,
): Promise<boolean> {
	if (gatedCount <= 0) {
		return false;
	}
	return confirmBatch();
}
