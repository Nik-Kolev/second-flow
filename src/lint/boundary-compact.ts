import type { TimelineEvent } from '../parser/index.js';
import { detectBoundaryCandidates } from '../stats/index.js';
import type { LintFinding } from './types.js';

// Not shared with stats/cache.ts's own hasCompactBetween — small enough that duplicating the
// timestamp-range check is simpler than exporting it across module boundaries for one caller.
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

// Each boundary (commit/push/PR-create/subagent-completion) is expected to be followed by a
// `/compact` before the next boundary starts, or before the timeline ends for the last one.
export function checkBoundaryFollowedByCompact(timeline: TimelineEvent[]): LintFinding[] {
	const candidates = detectBoundaryCandidates(timeline);
	const findings: LintFinding[] = [];

	for (let i = 0; i < candidates.length; i++) {
		const candidate = candidates[i];
		// The next candidate at a strictly LATER timestamp — candidates sharing this one's
		// timestamp (e.g. "git commit && git push" in one Bash call) are the same moment of work
		// completion, not separate windows, so they share one check window.
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
