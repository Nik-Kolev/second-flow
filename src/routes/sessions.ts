import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type Anthropic from '@anthropic-ai/sdk';
import {
	buildJudgmentRequestParams,
	checkGateAndBuildEvidence,
	createAuditRun,
	executeJudgmentForSession,
	JUDGMENT_PURPOSE,
	resolveJudgmentModel,
	sumTranscriptTokens,
} from '../analysis/index.js';
import type { JudgmentRequestParams } from '../analysis/index.js';
import {
	computeCallCostUsd,
	getNoteRecurrenceForSession,
	PRICING_PER_MTOK,
} from '../dashboard/index.js';
import { AuditedSessionStatus } from '../generated/prisma/index.js';
import type { AnalysisNote, AnalysisNoteKind } from '../generated/prisma/index.js';
import anthropicClient from '../lib/anthropic.js';
import prismaClient from '../lib/prisma.js';
import { runActivatedCheckers } from '../lint/index.js';
import type { LintFinding } from '../lint/index.js';
import {
	listSessionFiles,
	parseSessionFile,
	peekSessionCwd,
	resolveProjectsRoot,
	resolveSessionFilePath,
} from '../parser/index.js';
import type { ParsedSession } from '../parser/index.js';
import { resolveRulebook } from '../rulebook/index.js';
import type { RulebookDiscoveryOptions, RulebookResolution } from '../rulebook/index.js';
import { computeSessionStats } from '../stats/index.js';
import type { SessionStats } from '../stats/index.js';

// Structural superset of the judgment/activation client interfaces — routes also need the free count_tokens endpoint; the real SDK client satisfies all of them.
interface SessionsAnthropicClient {
	messages: {
		create(params: JudgmentRequestParams): Promise<Anthropic.Message>;
		countTokens(params: {
			model: string;
			messages: Array<{ role: 'user'; content: string }>;
			tools: Anthropic.ToolUnion[];
		}): Promise<{ input_tokens: number }>;
	};
}

export interface SessionsRouterDeps {
	prisma?: typeof prismaClient;
	anthropic?: SessionsAnthropicClient;
	// Threads through to resolveRulebook so tests can point global-CLAUDE.md discovery at a fixture dir.
	rulebookOpts?: RulebookDiscoveryOptions;
}

// A continued session appends to its transcript, so a size mismatch is a reliable signal; the mtime tolerance absorbs DateTime round-trip precision loss.
const MTIME_TOLERANCE_MS = 2000;

function isChangedSinceAudit(
	fileSize: number,
	fileMtimeMs: number,
	storedSize: number | null,
	storedMtime: Date | null,
): boolean | null {
	if (storedSize === null || storedMtime === null) {
		return null;
	}
	return (
		fileSize !== storedSize ||
		Math.abs(fileMtimeMs - storedMtime.getTime()) > MTIME_TOLERANCE_MS
	);
}

interface SessionArtifacts {
	filePath: string;
	fileStat: { size: number; mtime: Date };
	session: ParsedSession;
	stats: SessionStats;
	rulebook: RulebookResolution;
	lintFindings: LintFinding[];
}

// Shared by preview and audit — nearly free; the one exception is activation classification's single cached Haiku call on first sight of a rulebook.
async function loadSessionArtifacts(
	slug: string,
	sessionId: string,
	deps: SessionsRouterDeps,
): Promise<SessionArtifacts | null> {
	const filePath = resolveSessionFilePath(slug, sessionId);
	let stat;
	try {
		stat = await fs.stat(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return null;
		}
		throw error;
	}
	const session = await parseSessionFile(filePath, { projectSlug: slug });
	const stats = computeSessionStats(session);
	const rulebook = await resolveRulebook(
		session.attachments,
		session.meta,
		session.timeline,
		deps.rulebookOpts,
	);
	const lintFindings = await runActivatedCheckers(session.timeline, rulebook, deps);
	return {
		filePath,
		fileStat: { size: stat.size, mtime: stat.mtime },
		session,
		stats,
		rulebook,
		lintFindings,
	};
}

function summarizeTriggers(
	triggers: Array<{ kind: string }>,
): Array<{ kind: string; count: number }> {
	const counts = new Map<string, number>();
	for (const trigger of triggers) {
		counts.set(trigger.kind, (counts.get(trigger.kind) ?? 0) + 1);
	}
	return [...counts.entries()].map(([kind, count]) => ({ kind, count }));
}

export function createSessionsRouter(deps: SessionsRouterDeps = {}): Router {
	const prisma = deps.prisma ?? prismaClient;
	const anthropic = deps.anthropic ?? anthropicClient;
	const router = Router();
	// Closes the audit POST's check-then-act race — set synchronously before any await, same pattern as activation.ts's cache dedup.
	const auditsInFlight = new Set<string>();

	router.get('/projects', async (_req, res) => {
		const root = resolveProjectsRoot();
		let entries;
		try {
			entries = await fs.readdir(root, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				// A missing projects root just means no Claude Code sessions exist yet — a legitimate empty state, not an error.
				res.json({ projectsRoot: root, projects: [] });
				return;
			}
			throw error;
		}
		const projects: Array<{
			slug: string;
			sessionCount: number;
			latestSessionMtime: string;
			cwd: string | null;
		}> = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}
			const sessionFiles = await listSessionFiles(entry.name).catch(() => []);
			if (sessionFiles.length === 0) {
				continue;
			}
			const mtimes = await Promise.all(
				sessionFiles.map(async (file) => (await fs.stat(file)).mtimeMs),
			);
			const latestMtime = Math.max(...mtimes);
			// The slug is a lossy encoding of the real path — the transcript's own cwd is the only place the unambiguous path survives, for a friendly project name.
			const latestFile = sessionFiles[mtimes.indexOf(latestMtime)]!;
			const cwd = await peekSessionCwd(latestFile);
			projects.push({
				slug: entry.name,
				sessionCount: sessionFiles.length,
				latestSessionMtime: new Date(latestMtime).toISOString(),
				cwd,
			});
		}
		projects.sort((a, b) => b.latestSessionMtime.localeCompare(a.latestSessionMtime));
		res.json({ projectsRoot: root, projects });
	});

	router.get('/projects/:slug/sessions', async (req, res) => {
		const slug = req.params.slug;
		let files: string[];
		try {
			files = await listSessionFiles(slug);
		} catch (error) {
			if ((error as { cause?: NodeJS.ErrnoException }).cause?.code === 'ENOENT') {
				res.status(404).json({ error: `No project directory found for slug "${slug}"` });
				return;
			}
			throw error;
		}
		const fileInfos = await Promise.all(
			files.map(async (file) => {
				const stat = await fs.stat(file);
				return {
					sessionId: path.basename(file, '.jsonl'),
					fileSize: stat.size,
					fileMtimeMs: stat.mtimeMs,
				};
			}),
		);
		const audits = await prisma.auditedSession.findMany({
			where: {
				projectSlug: slug,
				transcriptSessionId: { in: fileInfos.map((info) => info.sessionId) },
			},
			orderBy: { createdAt: 'desc' },
		});
		// createdAt-desc order means first-seen per session id is its latest audit.
		const latestAudit = new Map<string, (typeof audits)[number]>();
		const auditCounts = new Map<string, number>();
		for (const audit of audits) {
			if (!latestAudit.has(audit.transcriptSessionId)) {
				latestAudit.set(audit.transcriptSessionId, audit);
			}
			auditCounts.set(
				audit.transcriptSessionId,
				(auditCounts.get(audit.transcriptSessionId) ?? 0) + 1,
			);
		}
		const sessions = fileInfos
			.map((info) => {
				const audit = latestAudit.get(info.sessionId);
				return {
					sessionId: info.sessionId,
					fileSize: info.fileSize,
					fileMtime: new Date(info.fileMtimeMs).toISOString(),
					audit: audit
						? {
								auditedSessionId: audit.id,
								status: audit.status,
								auditedAt: audit.createdAt.toISOString(),
								proposalsCreated: audit.proposalsCreated,
								notesCreated: audit.notesCreated,
								droppedProposalCount: audit.droppedProposalCount,
								auditCount: auditCounts.get(info.sessionId) ?? 0,
								changedSinceAudit: isChangedSinceAudit(
									info.fileSize,
									info.fileMtimeMs,
									audit.transcriptFileSize,
									audit.transcriptFileMtime,
								),
							}
						: null,
				};
			})
			.sort((a, b) => b.fileMtime.localeCompare(a.fileMtime));
		res.json({ slug, sessions });
	});

	router.post('/projects/:slug/sessions/:sessionId/preview', async (req, res) => {
		const { slug, sessionId } = req.params;
		const artifacts = await loadSessionArtifacts(slug, sessionId, deps);
		if (!artifacts) {
			res.status(404).json({ error: `No transcript found for session "${sessionId}"` });
			return;
		}
		const gateResult = checkGateAndBuildEvidence({
			session: artifacts.session,
			stats: artifacts.stats,
			lintFindings: artifacts.lintFindings,
			rulebook: artifacts.rulebook,
		});
		if (gateResult === null) {
			res.json({ gate: 'wavedThrough' });
			return;
		}

		const model = await resolveJudgmentModel(deps);
		const flaggedSignals = gateResult.triggers
			.map((trigger) => trigger.signal)
			.filter((signal): signal is string => signal !== undefined);
		const params = buildJudgmentRequestParams(
			model,
			artifacts.rulebook,
			gateResult.evidenceWindow,
			flaggedSignals,
		);

		// count_tokens is free but still a network call — an estimate failure must not block the preview.
		let estimate: {
			inputTokens: number;
			inputCostUsd: number;
			maxOutputTokens: number;
			maxTotalCostUsd: number;
		} | null = null;
		let estimateError: string | undefined;
		try {
			const counted = await anthropic.messages.countTokens({
				model: params.model,
				messages: params.messages,
				tools: params.tools,
			});
			const pricing = PRICING_PER_MTOK[model];
			if (pricing) {
				const inputCostUsd = (counted.input_tokens * pricing.input) / 1_000_000;
				const maxOutputCostUsd = (params.max_tokens * pricing.output) / 1_000_000;
				estimate = {
					inputTokens: counted.input_tokens,
					inputCostUsd,
					maxOutputTokens: params.max_tokens,
					maxTotalCostUsd: inputCostUsd + maxOutputCostUsd,
				};
			} else {
				estimateError = `No pricing entry for model "${model}"`;
			}
		} catch (error) {
			estimateError = error instanceof Error ? error.message : String(error);
		}

		res.json({
			gate: 'triggered',
			model,
			triggers: summarizeTriggers(gateResult.triggers),
			evidenceWindowEventCount: gateResult.evidenceWindow.length,
			estimate,
			...(estimateError !== undefined ? { estimateError } : {}),
		});
	});

	router.post('/projects/:slug/sessions/:sessionId/audit', async (req, res) => {
		const { slug, sessionId } = req.params;
		const force = (req.body as { force?: unknown } | undefined)?.force === true;

		const lockKey = `${slug}:${sessionId}`;
		if (auditsInFlight.has(lockKey)) {
			res.status(409).json({ error: 'An audit for this session is already in progress' });
			return;
		}
		auditsInFlight.add(lockKey);

		try {
			const existing = await prisma.auditedSession.findFirst({
				where: { projectSlug: slug, transcriptSessionId: sessionId },
				orderBy: { createdAt: 'desc' },
			});
			if (existing && !force) {
				res.status(409).json({
					error: 'Session already audited — pass force: true to re-audit',
					existing: {
						auditedSessionId: existing.id,
						status: existing.status,
						auditedAt: existing.createdAt.toISOString(),
					},
				});
				return;
			}

			const artifacts = await loadSessionArtifacts(slug, sessionId, deps);
			if (!artifacts) {
				res.status(404).json({ error: `No transcript found for session "${sessionId}"` });
				return;
			}
			const gateResult = checkGateAndBuildEvidence({
				session: artifacts.session,
				stats: artifacts.stats,
				lintFindings: artifacts.lintFindings,
				rulebook: artifacts.rulebook,
			});

			const auditRun = await createAuditRun(deps);
			try {
				if (gateResult === null) {
					// The free check is itself worth remembering — a wavedThrough row lets the session list say "audited, nothing found" without re-reading the transcript.
					const auditedSession = await prisma.auditedSession.create({
						data: {
							transcriptSessionId: artifacts.session.sessionId,
							projectSlug: artifacts.session.projectSlug,
							auditRunId: auditRun.id,
							status: AuditedSessionStatus.wavedThrough,
							transcriptTokenTotal: sumTranscriptTokens(artifacts.session.timeline),
							transcriptFileSize: artifacts.fileStat.size,
							transcriptFileMtime: artifacts.fileStat.mtime,
							proposalsCreated: 0,
							notesCreated: 0,
							droppedProposalCount: 0,
						},
					});
					res.json({ outcome: 'wavedThrough', auditedSessionId: auditedSession.id });
					return;
				}

				// No confirmJudgmentBatch here on purpose — this POST only fires from the UI's confirm dialog, so the request itself is the spend confirmation.
				const outcome = await executeJudgmentForSession(
					{
						session: artifacts.session,
						stats: artifacts.stats,
						lintFindings: artifacts.lintFindings,
						rulebook: artifacts.rulebook,
						transcriptFileStat: artifacts.fileStat,
					},
					auditRun.id,
					gateResult.evidenceWindow,
					gateResult.triggers,
					deps,
				);
				res.json(outcome);
			} finally {
				await prisma.auditRun.update({
					where: { id: auditRun.id },
					data: { completedAt: new Date() },
				});
			}
		} finally {
			auditsInFlight.delete(lockKey);
		}
	});

	router.get('/sessions/:auditedSessionId', async (req, res) => {
		const auditedSessionId = req.params.auditedSessionId;
		const auditedSession = await prisma.auditedSession.findUnique({
			where: { id: auditedSessionId },
			include: { ruleProposals: true, analysisNotes: true },
		});
		if (!auditedSession) {
			res.status(404).json({ error: `No audited session with id "${auditedSessionId}"` });
			return;
		}
		const recurrence = await getNoteRecurrenceForSession(auditedSessionId, deps);

		const historyRows = await prisma.auditedSession.findMany({
			where: {
				projectSlug: auditedSession.projectSlug,
				transcriptSessionId: auditedSession.transcriptSessionId,
			},
			orderBy: { createdAt: 'desc' },
			select: {
				id: true,
				auditRunId: true,
				status: true,
				createdAt: true,
				proposalsCreated: true,
				notesCreated: true,
				droppedProposalCount: true,
			},
		});
		const judgmentCalls = await prisma.auditRunCall.findMany({
			where: {
				auditRunId: { in: historyRows.map((row) => row.auditRunId) },
				purpose: JUDGMENT_PURPOSE,
			},
			select: {
				auditRunId: true,
				model: true,
				inputTokens: true,
				outputTokens: true,
				cacheReadTokens: true,
				cacheCreationTokens: true,
			},
		});
		const modelByAuditRunId = new Map(
			judgmentCalls.map((call) => [call.auditRunId, call.model]),
		);
		// A re-audit's judgment call determines its findings, so its cost/tokens are what's meaningful here, not activation/reconciliation spend.
		const costByAuditRunId = new Map(
			judgmentCalls.map((call) => [call.auditRunId, computeCallCostUsd(call)]),
		);
		const tokensByAuditRunId = new Map(
			judgmentCalls.map((call) => [
				call.auditRunId,
				{ inputTokens: call.inputTokens, outputTokens: call.outputTokens },
			]),
		);
		const history = historyRows.map((row) => ({
			auditedSessionId: row.id,
			status: row.status,
			model: modelByAuditRunId.get(row.auditRunId) ?? null,
			costUsd: costByAuditRunId.get(row.auditRunId) ?? null,
			inputTokens: tokensByAuditRunId.get(row.auditRunId)?.inputTokens ?? null,
			outputTokens: tokensByAuditRunId.get(row.auditRunId)?.outputTokens ?? null,
			auditedAt: row.createdAt.toISOString(),
			proposalsCreated: row.proposalsCreated,
			notesCreated: row.notesCreated,
			droppedProposalCount: row.droppedProposalCount,
			isCurrent: row.id === auditedSession.id,
		}));

		const notesByKind: Record<
			AnalysisNoteKind,
			Array<AnalysisNote & { recurrence: unknown }>
		> = {
			compliance: [],
			environmentalInstruction: [],
			promptCoaching: [],
		};
		for (const note of auditedSession.analysisNotes) {
			notesByKind[note.kind].push({
				...note,
				recurrence: note.ruleRef !== null ? (recurrence[note.ruleRef] ?? null) : null,
			});
		}

		res.json({
			auditedSession: {
				id: auditedSession.id,
				transcriptSessionId: auditedSession.transcriptSessionId,
				projectSlug: auditedSession.projectSlug,
				status: auditedSession.status,
				auditedAt: auditedSession.createdAt.toISOString(),
				transcriptTokenTotal: auditedSession.transcriptTokenTotal,
				proposalsCreated: auditedSession.proposalsCreated,
				notesCreated: auditedSession.notesCreated,
				droppedProposalCount: auditedSession.droppedProposalCount,
			},
			proposals: auditedSession.ruleProposals,
			notesByKind,
			history,
		});
	});

	return router;
}

export default createSessionsRouter;
