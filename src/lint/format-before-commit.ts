import type { TimelineEvent, ToolCallEvent } from '../parser/index.js';
import { detectBoundaryCandidates, extractShellCommand, SHELL_TOOL_NAMES } from '../stats/index.js';
import type { LintFinding } from './types.js';

// Generic on purpose (npm run format, prettier --write, eslint --fix, black, gofmt, rustfmt) — can false-positive on unrelated text containing these words, same tradeoff as boundaries.ts's GIT_COMMIT.
const FORMAT_COMMAND = /\bformat\b|\bprettier\b|--fix\b|\bblack\b|\bgofmt\b|\brustfmt\b/i;

export function checkFormatBeforeCommit(timeline: TimelineEvent[]): LintFinding[] {
	const commitToolUseIds = new Set(
		detectBoundaryCandidates(timeline)
			.filter((candidate) => candidate.kind === 'git-commit')
			.map((candidate) => candidate.toolUseId),
	);
	if (commitToolUseIds.size === 0) {
		return [];
	}

	const shellCalls = timeline.filter(
		(event): event is ToolCallEvent =>
			event.kind === 'tool-call' && SHELL_TOOL_NAMES.has(event.toolName),
	);

	const findings: LintFinding[] = [];
	let formattedSincePreviousCommit = false;

	for (const call of shellCalls) {
		const command = extractShellCommand(call.input);
		const commandFormats = command !== undefined && FORMAT_COMMAND.test(command);

		if (commitToolUseIds.has(call.toolUseId)) {
			if (!formattedSincePreviousCommit && !commandFormats) {
				findings.push({
					checkerId: 'format-before-commit',
					toolUseId: call.toolUseId,
					timestamp: call.callTimestamp,
					evidence: command ?? '(no command captured)',
				});
			}
			formattedSincePreviousCommit = false;
			continue;
		}

		if (commandFormats) {
			formattedSincePreviousCommit = true;
		}
	}

	return findings;
}
