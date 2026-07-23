import type { TimelineEvent, ToolCallEvent } from '../parser/index.js';
import { extractSubagentType } from './agents.js';
import type { BoundaryCandidate } from './types.js';

// Word-boundary matching means e.g. `git commit-graph` false-positives on GIT_COMMIT — accepted.
const GIT_COMMIT = /\bgit\s+commit\b/i;
const GIT_PUSH = /\bgit\s+push\b/i;
const GH_PR_CREATE = /\bgh\s+pr\s+create\b/i;

function extractBashCommand(input: unknown): string | undefined {
	if (typeof input !== 'object' || input === null) {
		return undefined;
	}
	const value = (input as { command?: unknown }).command;
	return typeof value === 'string' ? value : undefined;
}

function bashBoundaryCandidates(call: ToolCallEvent): BoundaryCandidate[] {
	if (call.toolName !== 'Bash') {
		return [];
	}
	const command = extractBashCommand(call.input);
	if (!command) {
		return [];
	}
	const candidates: BoundaryCandidate[] = [];
	if (GIT_COMMIT.test(command)) {
		candidates.push({
			kind: 'git-commit',
			toolUseId: call.toolUseId,
			timestamp: call.callTimestamp,
			detail: command,
		});
	}
	if (GIT_PUSH.test(command)) {
		candidates.push({
			kind: 'git-push',
			toolUseId: call.toolUseId,
			timestamp: call.callTimestamp,
			detail: command,
		});
	}
	if (GH_PR_CREATE.test(command)) {
		candidates.push({
			kind: 'gh-pr-create',
			toolUseId: call.toolUseId,
			timestamp: call.callTimestamp,
			detail: command,
		});
	}
	return candidates;
}

const TERMINAL_ASYNC_STATUSES = new Set(['completed', 'failed']);

function subagentCompletionCandidate(call: ToolCallEvent): BoundaryCandidate | undefined {
	if (!call.isSubagentSpawn) {
		return undefined;
	}
	const { result } = call;
	// Mirrors classify.ts's own terminal-status check in applyTaskNotification.
	const isTerminal =
		result.kind === 'sync' ||
		(result.kind === 'async-task-notification' &&
			TERMINAL_ASYNC_STATUSES.has(result.status ?? ''));
	if (!isTerminal) {
		return undefined;
	}
	return {
		kind: 'subagent-completion',
		toolUseId: call.toolUseId,
		timestamp: result.timestamp ?? call.callTimestamp,
		detail: extractSubagentType(call.input),
	};
}

export function detectBoundaryCandidates(timeline: TimelineEvent[]): BoundaryCandidate[] {
	const calls = timeline.filter((event): event is ToolCallEvent => event.kind === 'tool-call');
	const candidates: BoundaryCandidate[] = [];
	for (const call of calls) {
		candidates.push(...bashBoundaryCandidates(call));
		const completion = subagentCompletionCandidate(call);
		if (completion) {
			candidates.push(completion);
		}
	}
	return candidates;
}
