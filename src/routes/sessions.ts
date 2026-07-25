import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type Anthropic from '@anthropic-ai/sdk';
import {
	buildJudgmentRequestParams,
	checkGateAndBuildEvidence,
	createAuditRun,
	executeJudgmentForSession,
	resolveJudgmentModel,
	sumTranscriptTokens,
} from '../analysis/index.js';
import type { JudgmentRequestParams } from '../analysis/index.js';
import { getNoteRecurrenceForSession, PRICING_PER_MTOK } from '../dashboard/index.js';
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

// Structural superset of the judgment/activation client interfaces: routes additionally need the
// free count_tokens endpoint for preview estimates. The real SDK client satisfies all of them.
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
	// Threads through to resolveRulebook so tests can point the global-CLAUDE.md discovery at a
	// fixture directory instead of the real home directory.
	rulebookOpts?: RulebookDiscoveryOptions;
}

// A continued session appends to its transcript, so a size mismatch alone is a reliable signal.
// The mtime tolerance absorbs sub-second precision loss in the DateTime round-trip.
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

// Shared by preview and audit. Nearly free: parse/stats/lint are in-memory; the one exception is
// activation classification, which costs a single cached Haiku call on the first-ever sight of a
// given rulebook (logged to AuditRunCall by activation.ts) and nothing after that.
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
	const rulebook = await resolveRulebook(session.attachments, session.meta, deps.rulebookOpts);
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

	router.get('/projects', async (_req, res) => {
		const root = resolveProjectsRoot();
		let entries;
		try {
			entries = await fs.readdir(root, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				// A missing projects root just means no Claude Code sessions exist yet — a legitimate
				// empty state, not a server error.
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
			// The slug is a lossy encoding of the real path (a literal hyphen in a folder name is
			// indistinguishable from a path-separator hyphen once slugified) — the transcript itself
			// is the only place the real, unambiguous path survives, so the UI can show a friendly
			// project name instead of the raw slug.
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
		} catch {
			res.status(404).json({ error: `No project directory found for slug "${slug}"` });
			return;
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

		// count_tokens is free but still a network call — an estimate failure must not block the
		// preview, since the audit itself doesn't depend on it.
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
				// The free check is itself a result worth remembering: a wavedThrough row is what lets
				// the session list say "audited, nothing found" without ever re-reading the transcript.
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

			// No confirmJudgmentBatch call here on purpose: this POST only ever fires from the UI's
			// confirm dialog, so the request itself is the explicit spend confirmation — the
			// no-silent-spend principle is honored one layer up.
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
		});
	});

	return router;
}

export default createSessionsRouter;
