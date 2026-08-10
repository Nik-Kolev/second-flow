import { Router } from 'express';
import {
	getAuditSettings,
	isJudgmentModel,
	JUDGMENT_MODELS,
	updateJudgmentModel,
	updateMaxSonnetCallsPerRun,
} from '../analysis/index.js';
import {
	computeTotalSpendUsd,
	getRankedProposalGroups,
	PRICING_PER_MTOK,
} from '../dashboard/index.js';
import { RuleProposalStatus } from '../generated/prisma/index.js';
import prismaClient from '../lib/prisma.js';

export interface DashboardRouterDeps {
	prisma?: typeof prismaClient;
}

export function createDashboardRouter(deps: DashboardRouterDeps = {}): Router {
	const prisma = deps.prisma ?? prismaClient;
	const router = Router();

	router.get('/dashboard', async (_req, res) => {
		const [calls, proposals, settings, sessionsAudited, openProposals, droppedSum] =
			await Promise.all([
				prisma.auditRunCall.findMany(),
				getRankedProposalGroups(deps),
				getAuditSettings(deps),
				prisma.auditedSession.count(),
				prisma.ruleProposal.count({
					where: {
						status: {
							in: [
								RuleProposalStatus.proposed,
								RuleProposalStatus.needsConfirm,
								RuleProposalStatus.recurring,
							],
						},
					},
				}),
				prisma.auditedSession.aggregate({ _sum: { droppedProposalCount: true } }),
			]);
		res.json({
			proposals,
			stats: {
				totalSpendUsd: computeTotalSpendUsd(calls),
				sessionsAudited,
				openProposalCount: openProposals,
				// Lets the proposals tab distinguish "0 proposals" from "proposals dropped as invalid" — the ambiguity Unit 1 was built to end.
				droppedProposalTotal: droppedSum._sum.droppedProposalCount ?? 0,
			},
			settings: {
				judgmentModel: settings.judgmentModel,
				maxSonnetCallsPerRun: settings.maxSonnetCallsPerRun,
				models: JUDGMENT_MODELS.map((id) => ({
					id,
					pricing: PRICING_PER_MTOK[id] ?? null,
				})),
			},
		});
	});

	router.put('/dashboard/settings', async (req, res) => {
		const value: unknown = (req.body as { judgmentModel?: unknown } | undefined)?.judgmentModel;
		if (!isJudgmentModel(value)) {
			res.status(400).json({
				error: `judgmentModel must be one of: ${JUDGMENT_MODELS.join(', ')}`,
			});
			return;
		}
		const settings = await updateJudgmentModel(value, deps);
		res.json({ judgmentModel: settings.judgmentModel });
	});

	// Read-only over config everywhere else — this is the one scoped write, touching only AuditSettings. No UI since the per-audit confirm replaced the ceiling meter, but stays functional.
	router.put('/dashboard/ceiling', async (req, res) => {
		const value: unknown = req.body?.maxSonnetCallsPerRun;
		if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1000) {
			res.status(400).json({
				error: 'maxSonnetCallsPerRun must be an integer between 0 and 1000',
			});
			return;
		}
		const settings = await updateMaxSonnetCallsPerRun(value, deps);
		res.json({ maxSonnetCallsPerRun: settings.maxSonnetCallsPerRun });
	});

	return router;
}

export default createDashboardRouter;
