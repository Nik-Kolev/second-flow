import type { TimelineEvent, ToolCallEvent } from '../parser/index.js';
import type { AgentUsageStats, SubagentInvocation, SubagentTypeSummary } from './types.js';

export function extractSubagentType(input: unknown): string | undefined {
	if (typeof input !== 'object' || input === null) {
		return undefined;
	}
	const value = (input as { subagent_type?: unknown }).subagent_type;
	return typeof value === 'string' ? value : undefined;
}

function toSubagentInvocation(call: ToolCallEvent): SubagentInvocation {
	const base: SubagentInvocation = {
		toolUseId: call.toolUseId,
		subagentType: extractSubagentType(call.input),
		callTimestamp: call.callTimestamp,
		subagentModel: call.subagentModel,
	};
	if (call.result.kind === 'async-task-notification') {
		return { ...base, usage: call.result.usage, resultStatus: call.result.status };
	}
	if (call.result.kind === 'sync') {
		return { ...base, resultStatus: 'sync' };
	}
	return { ...base, resultStatus: 'pending' };
}

export function extractSubagentInvocations(timeline: TimelineEvent[]): SubagentInvocation[] {
	return timeline
		.filter(
			(event): event is ToolCallEvent => event.kind === 'tool-call' && event.isSubagentSpawn,
		)
		.map(toSubagentInvocation);
}

export function groupInvocationsByType(invocations: SubagentInvocation[]): SubagentTypeSummary[] {
	const byType = new Map<string, SubagentInvocation[]>();
	const singletons: SubagentInvocation[] = [];

	for (const invocation of invocations) {
		if (invocation.subagentType === undefined) {
			// Never merged into a shared "unknown" bucket — we don't actually know they're the same type.
			singletons.push(invocation);
			continue;
		}
		const group = byType.get(invocation.subagentType);
		if (group) {
			group.push(invocation);
		} else {
			byType.set(invocation.subagentType, [invocation]);
		}
	}

	const summaries: SubagentTypeSummary[] = [];
	for (const [subagentType, group] of byType) {
		summaries.push({
			subagentType,
			invocationCount: group.length,
			invocations: group,
			isRepeatCandidate: group.length > 1,
		});
	}
	for (const invocation of singletons) {
		summaries.push({
			invocationCount: 1,
			invocations: [invocation],
			isRepeatCandidate: false,
		});
	}
	return summaries;
}

export function computeAgentUsageStats(timeline: TimelineEvent[]): AgentUsageStats {
	const invocations = extractSubagentInvocations(timeline);
	return { invocations, byType: groupInvocationsByType(invocations) };
}
