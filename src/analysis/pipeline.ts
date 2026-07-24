import { AuditedSessionStatus } from '../generated/prisma/index.js';
import prismaClient from '../lib/prisma.js';
import type { LintFinding } from '../lint/index.js';
import type { ParsedSession, TimelineEvent } from '../parser/index.js';
import type { RulebookResolution } from '../rulebook/index.js';
import type { SessionStats } from '../stats/index.js';
import { checkCeiling, confirmJudgmentBatch } from './ceiling.js';
import type { CeilingDeps } from './ceiling.js';
import { buildEvidenceSpans, extractEvidenceWindow } from './evidence-window.js';
import { collectGateTriggers } from './gate.js';
import type { GateTrigger } from './gate.js';
import { persistJudgmentFindings, runJudgmentCall } from './judgment.js';
import type { JudgmentDeps } from './judgment.js';

export interface JudgmentPipelineInput {
	session: ParsedSession;
	stats: SessionStats;
	lintFindings: LintFinding[];
	rulebook: RulebookResolution;
}

export type PipelineExecDeps = JudgmentDeps & CeilingDeps;

export type JudgmentPipelineOutcome =
	| { outcome: 'wavedThrough' }
	| { outcome: 'declinedByUser' }
	| { outcome: 'skippedCeiling'; auditedSessionId: string }
	| {
			outcome: 'completed';
			auditedSessionId: string;
			proposalsCreated: number;
			notesCreated: number;
	  }
	| { outcome: 'errored'; auditedSessionId: string; usageLogged: boolean };

// Free, no DB/LLM. Returns null when Pass 1's gate finds nothing worth a Sonnet call — a waved-
// through session costs nothing and produces nothing, so it never reaches the DB at all.
export function checkGateAndBuildEvidence(
	input: JudgmentPipelineInput,
): { triggers: GateTrigger[]; evidenceWindow: TimelineEvent[] } | null {
	const triggers = collectGateTriggers(input.session, input.stats, input.lintFindings);
	if (triggers.length === 0) {
		return null;
	}
	const spans = buildEvidenceSpans(
		input.session.timeline.length,
		triggers.map((trigger) => trigger.timelineIndex),
	);
	return { triggers, evidenceWindow: extractEvidenceWindow(input.session.timeline, spans) };
}

// Assumes the gate already triggered and confirmation already happened (or wasn't needed) —
// callers loop sequentially, never Promise.all, so an in-flight call is always allowed to finish
// before the next session's ceiling check runs.
export async function executeJudgmentForSession(
	input: JudgmentPipelineInput,
	auditRunId: string,
	evidenceWindow: TimelineEvent[],
	deps: PipelineExecDeps = {},
): Promise<JudgmentPipelineOutcome> {
	const prisma = deps.prisma ?? prismaClient;

	const ceilingResult = await checkCeiling(auditRunId, deps);
	if (ceilingResult === 'ceilingExceeded') {
		const auditedSession = await prisma.auditedSession.create({
			data: {
				transcriptSessionId: input.session.sessionId,
				projectSlug: input.session.projectSlug,
				auditRunId,
				status: AuditedSessionStatus.skippedCeiling,
			},
		});
		return { outcome: 'skippedCeiling', auditedSessionId: auditedSession.id };
	}

	// Status is decided by the ceiling check alone, before Sonnet is ever called — a Sonnet call
	// that later errors still leaves the row `completed` (Pass 2 was genuinely attempted); the
	// schema has no separate "errored" status, only the return outcome reflects that distinction.
	const auditedSession = await prisma.auditedSession.create({
		data: {
			transcriptSessionId: input.session.sessionId,
			projectSlug: input.session.projectSlug,
			auditRunId,
			status: AuditedSessionStatus.completed,
		},
	});

	const callOutcome = await runJudgmentCall(auditRunId, input.rulebook, evidenceWindow, deps);
	if (callOutcome.outcome === 'errored') {
		return {
			outcome: 'errored',
			auditedSessionId: auditedSession.id,
			usageLogged: callOutcome.usageLogged,
		};
	}

	const { proposalsCreated, notesCreated } = await persistJudgmentFindings(
		auditedSession.id,
		callOutcome.findings,
		prisma,
	);
	return {
		outcome: 'completed',
		auditedSessionId: auditedSession.id,
		proposalsCreated,
		notesCreated,
	};
}

// Thin convenience wrapper for exactly one session, confirming once for that one session. A
// future multi-session batch runner (step 8) should call checkGateAndBuildEvidence across all
// its sessions up front, confirm once with the aggregate count, then call
// executeJudgmentForSession directly per session — not reuse this wrapper in a loop.
export async function runJudgmentPipelineForSession(
	input: JudgmentPipelineInput,
	auditRunId: string,
	confirmBatch: () => Promise<boolean>,
	deps: PipelineExecDeps = {},
): Promise<JudgmentPipelineOutcome> {
	const gateResult = checkGateAndBuildEvidence(input);
	if (gateResult === null) {
		return { outcome: 'wavedThrough' };
	}

	const confirmed = await confirmJudgmentBatch(1, confirmBatch);
	if (!confirmed) {
		return { outcome: 'declinedByUser' };
	}

	return executeJudgmentForSession(input, auditRunId, gateResult.evidenceWindow, deps);
}
