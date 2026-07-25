import prismaClient from '../lib/prisma.js';
import { JUDGMENT_PURPOSE } from './judgment.js';
import { getAuditSettings } from './settings.js';

// Settings live in settings.ts now (judgment.ts needs them too, and importing them from here
// would be circular since this file imports JUDGMENT_PURPOSE from judgment.ts) — re-exported so
// existing importers of ceiling.js keep working unchanged.
export {
	DEFAULT_MAX_SONNET_CALLS_PER_RUN,
	getAuditSettings,
	updateMaxSonnetCallsPerRun,
} from './settings.js';

export interface CeilingDeps {
	prisma?: typeof prismaClient;
	maxSonnetCalls?: number;
}

export type CeilingCheckResult = 'ok' | 'ceilingExceeded';

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
