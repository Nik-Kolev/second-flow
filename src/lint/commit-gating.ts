import type { TimelineEvent } from '../parser/index.js';
import { detectBoundaryCandidates, extractShellCommand } from '../stats/index.js';
import type { LintFinding } from './types.js';

// Proxy for "no approval": zero user turns since the last commit — fuzzier cases are Layer 2's job.
export function checkCommitGating(timeline: TimelineEvent[]): LintFinding[] {
	const commitToolUseIds = new Set(
		detectBoundaryCandidates(timeline)
			.filter((candidate) => candidate.kind === 'git-commit')
			.map((candidate) => candidate.toolUseId),
	);
	if (commitToolUseIds.size === 0) {
		return [];
	}

	const findings: LintFinding[] = [];
	let sawUserTurnSincePreviousCommit = false;

	for (const event of timeline) {
		if (event.kind === 'user-message' || event.kind === 'slash-command') {
			sawUserTurnSincePreviousCommit = true;
			continue;
		}
		if (event.kind !== 'tool-call' || !commitToolUseIds.has(event.toolUseId)) {
			continue;
		}
		if (!sawUserTurnSincePreviousCommit) {
			findings.push({
				checkerId: 'commit-gating',
				toolUseId: event.toolUseId,
				timestamp: event.callTimestamp,
				evidence: extractShellCommand(event.input) ?? '(no command captured)',
			});
		}
		sawUserTurnSincePreviousCommit = false;
	}

	return findings;
}
