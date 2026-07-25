import { Router } from 'express';
import {
	getAuditSettings,
	isJudgmentModel,
	JUDGMENT_MODELS,
	updateJudgmentModel,
	updateMaxSonnetCallsPerRun,
} from '../analysis/index.js';
import {
	getDashboardOverview,
	getRankedNotesByKind,
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

	// overview/notesByKind are legacy keys the current public/ page still reads — they go away
	// with the Unit 3 UI rebuild; stats/settings are the shape that UI will consume.
	router.get('/dashboard', async (_req, res) => {
		const [
			overview,
			proposals,
			notesByKind,
			settings,
			sessionsAudited,
			openProposals,
			noteCount,
		] = await Promise.all([
			getDashboardOverview(deps),
			getRankedProposalGroups(deps),
			getRankedNotesByKind(deps),
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
			prisma.analysisNote.count(),
		]);
		res.json({
			overview,
			proposals,
			notesByKind,
			stats: {
				totalSpendUsd: overview.totalSpendUsd,
				sessionsAudited,
				openProposalCount: openProposals,
				noteCount,
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

	// Read-only over your config everywhere else — this is the one scoped write step 8 makes, and it
	// only ever touches AuditSettings, never a rulebook/CLAUDE.md file.
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
