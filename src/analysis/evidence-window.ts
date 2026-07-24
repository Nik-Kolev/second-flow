import type { TimelineEvent } from '../parser/index.js';

export const EVIDENCE_WINDOW_RADIUS = 15;
export const EVIDENCE_WINDOW_MERGE_GAP = 4;
export const WHOLE_TIMELINE_FALLBACK_THRESHOLD = 60;

export interface EvidenceSpan {
	start: number;
	end: number;
}

// Fixed-radius heuristic, not an agentic "Sonnet asks for more context" loop — every other LLM
// call in this project is single-shot, and letting Sonnet request more context would make the
// per-session call count unbounded, undermining the spend ceiling this step also builds.
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

// Spans are pre-merged/sorted/non-overlapping by construction (buildEvidenceSpans), so this
// can't produce duplicate events across spans.
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
