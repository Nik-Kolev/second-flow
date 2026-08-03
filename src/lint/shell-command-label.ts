import type { AssistantTurnEvent, TimelineEvent } from '../parser/index.js';
import { extractShellCommand, SHELL_TOOL_NAMES } from '../stats/index.js';
import type { LintFinding } from './types.js';

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

// Requires a RUNNING: label immediately before each shell call, per-call not per-turn.
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
