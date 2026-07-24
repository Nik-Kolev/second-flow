import type { ParsedSession } from '../parser/index.js';
import type { LintFinding } from '../lint/index.js';
import type { SessionStats } from '../stats/index.js';
import { isClarifyingQuestion, isUserPushback } from './heuristics.js';
import { buildTimelineIndex, resolveById, resolveTurnIndex } from './timeline-index.js';

export type GateTriggerKind =
	| 'lint-finding'
	| 'rate-limit-hit'
	| 'unexplained-cache-drop'
	| 'repeat-subagent-invocation'
	| 'user-pushback'
	| 'user-clarifying-question';

export interface GateTrigger {
	kind: GateTriggerKind;
	timelineIndex: number;
	// Only set for trigger kinds whose raw evidence-window text doesn't self-explain (a rate-limit
	// status code, a cache-ratio drop) — lint findings, repeat-subagent calls, and user messages
	// are already visible directly in the serialized evidence window, so they leave this unset.
	signal?: string;
}

// Free, no DB/LLM — decides whether a session is worth Pass 2's Sonnet call. Any deterministic
// lint finding (which already includes the boundary-compact checker when activated) is the
// primary trigger; the rest are the supporting signals stats/heuristics already compute.
export function collectGateTriggers(
	session: ParsedSession,
	stats: SessionStats,
	lintFindings: LintFinding[],
): GateTrigger[] {
	const timelineIndex = buildTimelineIndex(session.timeline);
	const triggers: GateTrigger[] = [];

	for (const finding of lintFindings) {
		const rawIndex = resolveById(timelineIndex, finding.toolUseId);
		if (rawIndex !== undefined) {
			triggers.push({ kind: 'lint-finding', timelineIndex: rawIndex });
		}
	}

	for (const hit of stats.rateLimitHits) {
		const rawIndex = resolveTurnIndex(timelineIndex, hit.turnIndex);
		if (rawIndex !== undefined) {
			triggers.push({
				kind: 'rate-limit-hit',
				timelineIndex: rawIndex,
				signal: `Rate limit hit (status ${hit.apiErrorStatus ?? 'unknown'})`,
			});
		}
	}

	for (const drop of stats.cache.unexplainedDrops) {
		const rawIndex = resolveTurnIndex(timelineIndex, drop.toTurnIndex);
		if (rawIndex !== undefined) {
			triggers.push({
				kind: 'unexplained-cache-drop',
				timelineIndex: rawIndex,
				signal:
					`Cache-read ratio dropped from ${drop.fromRatio.toFixed(2)} to ` +
					`${drop.toRatio.toFixed(2)} with no intervening /compact`,
			});
		}
	}

	for (const summary of stats.agents.byType) {
		if (!summary.isRepeatCandidate) {
			continue;
		}
		for (const invocation of summary.invocations) {
			const rawIndex = resolveById(timelineIndex, invocation.toolUseId);
			if (rawIndex !== undefined) {
				triggers.push({ kind: 'repeat-subagent-invocation', timelineIndex: rawIndex });
			}
		}
	}

	session.timeline.forEach((event, rawIndex) => {
		if (event.kind !== 'user-message') {
			return;
		}
		if (isUserPushback(event.text)) {
			triggers.push({ kind: 'user-pushback', timelineIndex: rawIndex });
		}
		if (isClarifyingQuestion(event.text)) {
			triggers.push({ kind: 'user-clarifying-question', timelineIndex: rawIndex });
		}
	});

	return triggers;
}
