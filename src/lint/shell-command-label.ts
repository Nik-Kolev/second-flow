import type { AssistantTurnEvent, TimelineEvent } from '../parser/index.js';
import { extractShellCommand, SHELL_TOOL_NAMES } from '../stats/index.js';
import type { LintFinding } from './types.js';

// Any non-empty prose counts. Whether that prose is actually outcome-focused rather than a restatement of the command is a judgment call, so it belongs to Layer 2, not here.
function isLabeled(turn: AssistantTurnEvent | undefined, toolUseId: string): boolean {
	const blocks = turn?.content ?? [];
	const index = blocks.findIndex((block) => block.type === 'tool_use' && block.id === toolUseId);
	if (index < 1) {
		return false;
	}
	// Thinking is collapsed and never shown, so it is not narration — but it must not break adjacency either, since the model interleaves it freely between the text and the call.
	let cursor = index - 1;
	while (cursor >= 0 && blocks[cursor].type === 'thinking') {
		cursor -= 1;
	}
	const preceding = cursor >= 0 ? blocks[cursor] : undefined;
	if (preceding?.type !== 'text') {
		return false;
	}
	return (preceding as { type: 'text'; text: string }).text.trim().length > 0;
}

// Catches only the mechanically-provable case: a shell call run with no narration at all, per-call not per-turn.
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
