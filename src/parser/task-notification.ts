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

// Parses Claude Code's XML-ish <task-notification> text; returns null so the caller can fall back to a plain user message.
export function parseTaskNotification(content: string): TaskNotificationInfo | null {
	const toolUseId = extractTag(content, 'tool-use-id');
	const taskId = extractTag(content, 'task-id');
	const status = extractTag(content, 'status');

	if (!toolUseId && !taskId && !status) {
		return null;
	}

	const summary = extractTag(content, 'summary');
	const outputFile = extractTag(content, 'output-file');

	// Greedy on purpose — a subagent's own result text can contain literal <result>-looking substrings that a non-greedy match would stop at.
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
