import { getAuditSettings } from '../analysis/ceiling.js';
import { JUDGMENT_PURPOSE } from '../analysis/judgment.js';
import { AuditedSessionStatus } from '../generated/prisma/index.js';
import prismaClient from '../lib/prisma.js';
import { computeTotalSpendUsd } from './pricing.js';

export interface OverviewDeps {
	prisma?: typeof prismaClient;
}

export interface DashboardOverview {
	totalSpendUsd: number;
	transcriptTokenTotal: number;
	ceiling: {
		max: number;
		consumedThisRun: number;
		runId: string | null;
		runInProgress: boolean;
	};
	cappedRun: {
		isCapped: boolean;
		skippedSessionCount: number;
	};
}

export async function getDashboardOverview(deps: OverviewDeps = {}): Promise<DashboardOverview> {
	const prisma = deps.prisma ?? prismaClient;

	const [calls, sessions, settings] = await Promise.all([
		prisma.auditRunCall.findMany(),
		prisma.auditedSession.findMany({ select: { transcriptTokenTotal: true } }),
		getAuditSettings(deps),
	]);

	const totalSpendUsd = computeTotalSpendUsd(calls);
	const transcriptTokenTotal = sessions.reduce(
		(total, session) => total + (session.transcriptTokenTotal ?? 0),
		0,
	);

	// "Current run": the in-progress run if one exists, else the most recently completed one — so
	// the strip isn't blank when the tool is idle between audits.
	const inProgressRun = await prisma.auditRun.findFirst({
		where: { completedAt: null },
		orderBy: { startedAt: 'desc' },
	});
	const currentRun =
		inProgressRun ?? (await prisma.auditRun.findFirst({ orderBy: { startedAt: 'desc' } }));

	let consumedThisRun = 0;
	let skippedSessionCount = 0;
	if (currentRun) {
		[consumedThisRun, skippedSessionCount] = await Promise.all([
			prisma.auditRunCall.count({
				where: { auditRunId: currentRun.id, purpose: JUDGMENT_PURPOSE },
			}),
			prisma.auditedSession.count({
				where: { auditRunId: currentRun.id, status: AuditedSessionStatus.skippedCeiling },
			}),
		]);
	}

	return {
		totalSpendUsd,
		transcriptTokenTotal,
		ceiling: {
			max: settings.maxSonnetCallsPerRun,
			consumedThisRun,
			runId: currentRun?.id ?? null,
			runInProgress: inProgressRun !== null,
		},
		cappedRun: {
			isCapped: skippedSessionCount > 0,
			skippedSessionCount,
		},
	};
}
