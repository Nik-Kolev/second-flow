import type { TimelineEvent } from '../parser/index.js';
import { detectBoundaryCandidates } from '../stats/index.js';
import type { LintFinding } from './types.js';

// Not shared with stats/cache.ts's own hasCompactBetween — too small to be worth exporting for one caller.
function hasCompactAfter(
	timeline: TimelineEvent[],
	fromTimestamp: string,
	toTimestamp?: string,
): boolean {
	return timeline.some(
		(event) =>
			event.kind === 'slash-command' &&
			event.commandName === 'compact' &&
			event.timestamp !== undefined &&
			event.timestamp > fromTimestamp &&
			(toTimestamp === undefined || event.timestamp < toTimestamp),
	);
}

// Each boundary is expected to be followed by /compact before the next one starts, or before the timeline ends.
export function checkBoundaryFollowedByCompact(timeline: TimelineEvent[]): LintFinding[] {
	const candidates = detectBoundaryCandidates(timeline);
	const findings: LintFinding[] = [];

	for (let i = 0; i < candidates.length; i++) {
		const candidate = candidates[i];
		// Only a strictly later candidate starts a new window; same-timestamp ones share this one.
		const next = candidates.slice(i + 1).find((later) => later.timestamp > candidate.timestamp);
		if (!hasCompactAfter(timeline, candidate.timestamp, next?.timestamp)) {
			findings.push({
				checkerId: 'boundary-compact',
				toolUseId: candidate.toolUseId,
				timestamp: candidate.timestamp,
				evidence: candidate.detail ?? `${candidate.kind} not followed by /compact`,
			});
		}
	}

	return findings;
}
