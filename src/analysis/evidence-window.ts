import type { TimelineEvent } from '../parser/index.js';

export const EVIDENCE_WINDOW_RADIUS = 15;
export const EVIDENCE_WINDOW_MERGE_GAP = 4;
export const WHOLE_TIMELINE_FALLBACK_THRESHOLD = 60;
export const MAX_SPAN_TRIGGERS_PER_KIND = 5;

// A per-call checker fires once per shell call, so triggers scale with session length — measured at 75-92% timeline coverage, which is not a bound at all. Sampling evenly rather than taking the first N keeps the window spread across the whole session instead of clustering at its start.
export function selectSpanTriggers<T extends { kind: string }>(
	triggers: T[],
	maxPerKind: number = MAX_SPAN_TRIGGERS_PER_KIND,
): T[] {
	const byKind = new Map<string, T[]>();
	for (const trigger of triggers) {
		const existing = byKind.get(trigger.kind);
		if (existing) {
			existing.push(trigger);
		} else {
			byKind.set(trigger.kind, [trigger]);
		}
	}

	const selected: T[] = [];
	for (const group of byKind.values()) {
		if (group.length <= maxPerKind) {
			selected.push(...group);
			continue;
		}
		if (maxPerKind <= 1) {
			selected.push(group[0]);
			continue;
		}
		const step = (group.length - 1) / (maxPerKind - 1);
		for (let i = 0; i < maxPerKind; i++) {
			selected.push(group[Math.round(i * step)]);
		}
	}
	return selected;
}

export interface EvidenceSpan {
	start: number;
	end: number;
}

// Fixed-radius, not an agentic "ask for more context" loop — keeps the per-session call count bounded for the spend ceiling.
export function buildEvidenceSpans(
	timelineLength: number,
	triggerIndices: number[],
): EvidenceSpan[] {
	if (triggerIndices.length === 0 || timelineLength === 0) {
		return [];
	}

	if (timelineLength <= WHOLE_TIMELINE_FALLBACK_THRESHOLD) {
		return [{ start: 0, end: timelineLength - 1 }];
	}

	const rawSpans = triggerIndices
		.map((index) => ({
			start: Math.max(0, index - EVIDENCE_WINDOW_RADIUS),
			end: Math.min(timelineLength - 1, index + EVIDENCE_WINDOW_RADIUS),
		}))
		.sort((a, b) => a.start - b.start);

	const merged: EvidenceSpan[] = [];
	for (const span of rawSpans) {
		const last = merged[merged.length - 1];
		if (last && span.start <= last.end + EVIDENCE_WINDOW_MERGE_GAP) {
			last.end = Math.max(last.end, span.end);
		} else {
			merged.push({ ...span });
		}
	}

	return merged;
}

// Spans are pre-merged/sorted/non-overlapping by construction, so this can't produce duplicate events.
export function extractEvidenceWindow(
	timeline: TimelineEvent[],
	spans: EvidenceSpan[],
): TimelineEvent[] {
	const events: TimelineEvent[] = [];
	for (const span of spans) {
		events.push(...timeline.slice(span.start, span.end + 1));
	}
	return events;
}
