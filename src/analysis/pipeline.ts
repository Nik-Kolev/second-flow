import { AuditedSessionStatus } from '../generated/prisma/index.js';
import prismaClient from '../lib/prisma.js';
import type { LintFinding } from '../lint/index.js';
import type { ParsedSession, TimelineEvent } from '../parser/index.js';
import type { RulebookResolution } from '../rulebook/index.js';
import type { SessionStats } from '../stats/index.js';
import { checkCeiling, confirmJudgmentBatch } from './ceiling.js';
import type { CeilingDeps } from './ceiling.js';
import {
	buildEvidenceSpans,
	extractEvidenceWindow,
	selectSpanTriggers,
} from './evidence-window.js';
import { collectGateTriggers } from './gate.js';
import type { GateTrigger } from './gate.js';
import { persistJudgmentFindings, runJudgmentCall } from './judgment.js';
import type { JudgmentDeps } from './judgment.js';

export interface JudgmentPipelineInput {
	session: ParsedSession;
	stats: SessionStats;
	lintFindings: LintFinding[];
	rulebook: RulebookResolution;
	// Persisted so a later size/mtime mismatch can flag "changed since audit" — optional since the CLI path doesn't stat.
	transcriptFileStat?: { size: number; mtime: Date };
}

export type PipelineExecDeps = JudgmentDeps & CeilingDeps;

// Sums every turn, not just the latest (unlike context-budget.ts's turnContextTokens) since each turn is separately billed; also used by the audit route's wavedThrough rows.
export function sumTranscriptTokens(timeline: TimelineEvent[]): number {
	let total = 0;
	for (const event of timeline) {
		if (event.kind !== 'assistant-turn') {
			continue;
		}
		const { usage } = event;
		total +=
			usage.inputTokens +
			usage.outputTokens +
			(usage.cacheReadInputTokens ?? 0) +
			(usage.cacheCreationInputTokens ?? 0);
	}
	return total;
}

export type JudgmentPipelineOutcome =
	| { outcome: 'wavedThrough' }
	| { outcome: 'declinedByUser' }
	| { outcome: 'skippedCeiling'; auditedSessionId: string }
	| {
			outcome: 'completed';
			auditedSessionId: string;
			proposalsCreated: number;
			notesCreated: number;
			droppedProposalCount: number;
	  }
	| { outcome: 'errored'; auditedSessionId: string; usageLogged: boolean };

// Free, no DB/LLM. Returns null when Pass 1's gate finds nothing worth a Sonnet call — a wavedThrough session never reaches the DB at all.
export function checkGateAndBuildEvidence(
	input: JudgmentPipelineInput,
): { triggers: GateTrigger[]; evidenceWindow: TimelineEvent[] } | null {
	const triggers = collectGateTriggers(input.session, input.stats, input.lintFindings);
	if (triggers.length === 0) {
		return null;
	}
	// Capped for span-building only — `triggers` stays complete so the confirm dialog's breakdown and flaggedSignals still report every one.
	const spans = buildEvidenceSpans(
		input.session.timeline.length,
		selectSpanTriggers(triggers).map((trigger) => trigger.timelineIndex),
	);
	return { triggers, evidenceWindow: extractEvidenceWindow(input.session.timeline, spans) };
}

// Assumes the gate already triggered and confirmation already happened — callers loop sequentially, never Promise.all.
export async function executeJudgmentForSession(
	input: JudgmentPipelineInput,
	auditRunId: string,
	evidenceWindow: TimelineEvent[],
	triggers: GateTrigger[],
	deps: PipelineExecDeps = {},
): Promise<JudgmentPipelineOutcome> {
	const prisma = deps.prisma ?? prismaClient;

	const transcriptTokenTotal = sumTranscriptTokens(input.session.timeline);

	const ceilingResult = await checkCeiling(auditRunId, deps);
	if (ceilingResult === 'ceilingExceeded') {
		const auditedSession = await prisma.auditedSession.create({
			data: {
				transcriptSessionId: input.session.sessionId,
				projectSlug: input.session.projectSlug,
				auditRunId,
				status: AuditedSessionStatus.skippedCeiling,
				transcriptTokenTotal,
				transcriptFileSize: input.transcriptFileStat?.size,
				transcriptFileMtime: input.transcriptFileStat?.mtime,
			},
		});
		return { outcome: 'skippedCeiling', auditedSessionId: auditedSession.id };
	}

	// Created optimistically as `completed`, corrected to `errored` below on failure — so even a mid-call crash leaves a visible record.
	const auditedSession = await prisma.auditedSession.create({
		data: {
			transcriptSessionId: input.session.sessionId,
			projectSlug: input.session.projectSlug,
			auditRunId,
			status: AuditedSessionStatus.completed,
			transcriptTokenTotal,
			transcriptFileSize: input.transcriptFileStat?.size,
			transcriptFileMtime: input.transcriptFileStat?.mtime,
		},
	});

	const flaggedSignals = triggers
		.map((trigger) => trigger.signal)
		.filter((signal): signal is string => signal !== undefined);
	const callOutcome = await runJudgmentCall(
		auditRunId,
		input.rulebook,
		evidenceWindow,
		flaggedSignals,
		deps,
	);
	if (callOutcome.outcome === 'errored') {
		await prisma.auditedSession.update({
			where: { id: auditedSession.id },
			data: { status: AuditedSessionStatus.errored },
		});
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
	await prisma.auditedSession.update({
		where: { id: auditedSession.id },
		data: {
			proposalsCreated,
			notesCreated,
			droppedProposalCount: callOutcome.droppedProposalCount,
		},
	});
	return {
		outcome: 'completed',
		auditedSessionId: auditedSession.id,
		proposalsCreated,
		notesCreated,
		droppedProposalCount: callOutcome.droppedProposalCount,
	};
}

// Thin convenience wrapper for exactly one session — a future batch runner should call executeJudgmentForSession directly per session, not reuse this in a loop.
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

	return executeJudgmentForSession(
		input,
		auditRunId,
		gateResult.evidenceWindow,
		gateResult.triggers,
		deps,
	);
}
