import prismaClient from '../lib/prisma.js';
import { JUDGMENT_PURPOSE } from './judgment.js';
import { getAuditSettings } from './settings.js';

// Re-exported from settings.ts (avoids a circular import with judgment.ts) so existing importers of ceiling.js keep working.
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

// DB-backed so it can't desync across restarts — currently dormant since every caller does one call per run, so callCount is always 0 until a multi-session batch runner exists.
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

// No safe silent default for "spend real money" — confirmBatch is required everywhere, never defaulted.
export async function confirmJudgmentBatch(
	gatedCount: number,
	confirmBatch: () => Promise<boolean>,
): Promise<boolean> {
	if (gatedCount <= 0) {
		return false;
	}
	return confirmBatch();
}
