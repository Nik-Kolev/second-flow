import type { TimelineEvent } from '../parser/index.js';
import { detectBoundaryCandidates, extractShellCommand } from '../stats/index.js';
import type { LintFinding } from './types.js';

// Mechanical proxy for "no preceding approval turn": a commit with zero user turns (plain
// messages or slash commands) since the previous commit is provably impossible to have been
// approved — the assistant never yielded back to the user in between. A user turn that *isn't*
// real approval (an unrelated question, say) is a fuzzier case this deterministic layer can't
// tell apart — that's Layer 2's (Sonnet judgment pass) job, not this checker's.
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
