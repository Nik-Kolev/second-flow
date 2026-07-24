import prismaClient from '../lib/prisma.js';
import type { AuditSettings } from '../generated/prisma/index.js';
import { JUDGMENT_PURPOSE } from './judgment.js';

export const DEFAULT_MAX_SONNET_CALLS_PER_RUN = 10;

export interface CeilingDeps {
	prisma?: typeof prismaClient;
	maxSonnetCalls?: number;
}

export type CeilingCheckResult = 'ok' | 'ceilingExceeded';

// Lazily created singleton — the first read creates the row, seeded from
// DEFAULT_MAX_SONNET_CALLS_PER_RUN so there's one source of truth for the starting value. Persisted
// (not just a runtime default) so the step-8 dashboard's ceiling control can change it with no
// config file and no restart — checkCeiling below reads through to this on every call.
export async function getAuditSettings(deps: CeilingDeps = {}): Promise<AuditSettings> {
	const prisma = deps.prisma ?? prismaClient;
	const existing = await prisma.auditSettings.findFirst();
	if (existing) {
		return existing;
	}
	return prisma.auditSettings.create({
		data: { maxSonnetCallsPerRun: DEFAULT_MAX_SONNET_CALLS_PER_RUN },
	});
}

export async function updateMaxSonnetCallsPerRun(
	value: number,
	deps: CeilingDeps = {},
): Promise<AuditSettings> {
	const prisma = deps.prisma ?? prismaClient;
	const settings = await getAuditSettings(deps);
	return prisma.auditSettings.update({
		where: { id: settings.id },
		data: { maxSonnetCallsPerRun: value },
	});
}

// Queried from the DB (the existing AuditRunCall ledger) rather than an in-memory counter, so
// the ceiling can't desync across process restarts — same DB-is-the-ledger philosophy step 6 set.
// The effective ceiling itself also comes from the DB (AuditSettings, step 8) rather than a
// hardcoded constant now — deps.maxSonnetCalls still wins when a caller passes an explicit
// override, and short-circuits before the settings row is ever read in that case.
export async function checkCeiling(
	auditRunId: string,
	deps: CeilingDeps = {},
): Promise<CeilingCheckResult> {
	const prisma = deps.prisma ?? prismaClient;
	const maxSonnetCalls =
		deps.maxSonnetCalls ?? (await getAuditSettings(deps)).maxSonnetCallsPerRun;

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
