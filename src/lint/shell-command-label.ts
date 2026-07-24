import type { AssistantTurnEvent, TimelineEvent } from '../parser/index.js';
import { extractShellCommand } from '../stats/index.js';
import type { LintFinding } from './types.js';

const SHELL_TOOL_NAMES = new Set(['Bash', 'PowerShell']);
const RUNNING_LABEL = /^RUNNING:/m;

function isLabeled(turn: AssistantTurnEvent | undefined, toolUseId: string): boolean {
	const blocks = turn?.content ?? [];
	const index = blocks.findIndex((block) => block.type === 'tool_use' && block.id === toolUseId);
	const preceding = index > 0 ? blocks[index - 1] : undefined;
	if (preceding?.type !== 'text') {
		return false;
	}
	return RUNNING_LABEL.test((preceding as { type: 'text'; text: string }).text);
}

// Checks the user's own global rule: every shell tool call needs a one-line `RUNNING:` label
// in the immediately preceding text block of the same turn — not just anywhere earlier in it,
// since a turn can chain several shell calls that each need their own label.
export function checkShellCommandLabel(timeline: TimelineEvent[]): LintFinding[] {
	const turnByUuid = new Map<string, AssistantTurnEvent>();
	for (const event of timeline) {
		if (event.kind === 'assistant-turn') {
			turnByUuid.set(event.uuid, event);
		}
	}

	const findings: LintFinding[] = [];
	for (const event of timeline) {
		if (event.kind !== 'tool-call' || !SHELL_TOOL_NAMES.has(event.toolName)) {
			continue;
		}
		if (!isLabeled(turnByUuid.get(event.callerUuid), event.toolUseId)) {
			findings.push({
				checkerId: 'shell-command-label',
				toolUseId: event.toolUseId,
				timestamp: event.callTimestamp,
				evidence: extractShellCommand(event.input) ?? '(no command captured)',
			});
		}
	}
	return findings;
}
