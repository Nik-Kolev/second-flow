import { scrubText } from './scrub.js';
import type { SubagentUsage } from './types.js';

export interface TaskNotificationInfo {
	taskId?: string;
	toolUseId?: string;
	status?: string;
	summary?: string;
	outputFile?: string;
	result?: string;
	usage?: SubagentUsage;
}

function extractTag(content: string, tag: string): string | undefined {
	const match = content.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
	return match ? match[1].trim() : undefined;
}

function extractNumberTag(content: string, tag: string): number | undefined {
	const match = content.match(new RegExp(`<${tag}>(\\d+)<\\/${tag}>`));
	return match ? Number(match[1]) : undefined;
}

/**
 * Parses Claude Code's XML-ish `<task-notification>` text (not real XML — a handful of fixed
 * tags). Returns null when the content doesn't actually look like a task-notification, so the
 * caller can fall back to treating the record as a plain user message instead of crashing.
 */
export function parseTaskNotification(content: string): TaskNotificationInfo | null {
	const toolUseId = extractTag(content, 'tool-use-id');
	const taskId = extractTag(content, 'task-id');
	const status = extractTag(content, 'status');

	if (!toolUseId && !taskId && !status) {
		return null;
	}

	const summary = extractTag(content, 'summary');
	const outputFile = extractTag(content, 'output-file');

	// Greedy, anchored on the fixed `</result>\n<usage>` boundary — a subagent's own result text
	// can itself contain literal `<result>`-looking substrings, so a non-greedy match would stop early.
	const resultMatch = content.match(/<result>([\s\S]*)<\/result>\n<usage>/);
	const result = resultMatch ? scrubText(resultMatch[1]) : undefined;

	const usageBlockMatch = content.match(/<usage>([\s\S]*?)<\/usage>/);
	const usage = usageBlockMatch
		? {
				subagentTokens: extractNumberTag(usageBlockMatch[1], 'subagent_tokens'),
				toolUses: extractNumberTag(usageBlockMatch[1], 'tool_uses'),
				durationMs: extractNumberTag(usageBlockMatch[1], 'duration_ms'),
			}
		: undefined;

	return { taskId, toolUseId, status, summary, outputFile, result, usage };
}
