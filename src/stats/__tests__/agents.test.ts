import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ToolCallEvent } from '../../parser/index.js';
import {
	computeAgentUsageStats,
	extractSubagentInvocations,
	extractSubagentType,
	groupInvocationsByType,
} from '../agents.js';

function makeCall(overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
	return {
		kind: 'tool-call',
		toolUseId: 'toolu_1',
		toolName: 'Agent',
		input: { subagent_type: 'Explore' },
		callerUuid: 'u1',
		callTimestamp: 't1',
		isSubagentSpawn: true,
		isBackground: false,
		result: { kind: 'pending' },
		...overrides,
	};
}

test('extractSubagentType reads a string subagent_type', () => {
	assert.equal(extractSubagentType({ subagent_type: 'Explore' }), 'Explore');
});

test('extractSubagentType returns undefined when absent or not a string', () => {
	assert.equal(extractSubagentType({}), undefined);
	assert.equal(extractSubagentType({ subagent_type: 42 }), undefined);
	assert.equal(extractSubagentType(null), undefined);
	assert.equal(extractSubagentType('not an object'), undefined);
});

test('extractSubagentInvocations only includes subagent-spawn tool calls', () => {
	const timeline = [
		makeCall({ toolUseId: 'toolu_1' }),
		makeCall({ toolUseId: 'toolu_2', toolName: 'Read', isSubagentSpawn: false }),
	];
	const invocations = extractSubagentInvocations(timeline);
	assert.equal(invocations.length, 1);
	assert.equal(invocations[0].toolUseId, 'toolu_1');
});

test('extractSubagentInvocations pulls usage/model/status from an async-task-notification result', () => {
	const timeline = [
		makeCall({
			subagentModel: 'claude-sonnet-5',
			result: {
				kind: 'async-task-notification',
				status: 'completed',
				usage: { subagentTokens: 500, toolUses: 3, durationMs: 1000 },
			},
		}),
	];
	const [invocation] = extractSubagentInvocations(timeline);
	assert.equal(invocation.subagentModel, 'claude-sonnet-5');
	assert.equal(invocation.resultStatus, 'completed');
	assert.equal(invocation.usage?.subagentTokens, 500);
});

test('extractSubagentInvocations marks a sync result and a pending result correctly', () => {
	const timeline = [
		makeCall({ toolUseId: 'toolu_sync', result: { kind: 'sync', text: 'done' } }),
		makeCall({ toolUseId: 'toolu_pending', result: { kind: 'pending' } }),
	];
	const invocations = extractSubagentInvocations(timeline);
	assert.equal(invocations.find((i) => i.toolUseId === 'toolu_sync')?.resultStatus, 'sync');
	assert.equal(invocations.find((i) => i.toolUseId === 'toolu_pending')?.resultStatus, 'pending');
});

test('groupInvocationsByType flags a repeated type as a candidate, not a single one', () => {
	const timeline = [
		makeCall({ toolUseId: 'toolu_1', input: { subagent_type: 'Explore' } }),
		makeCall({ toolUseId: 'toolu_2', input: { subagent_type: 'Explore' } }),
		makeCall({ toolUseId: 'toolu_3', input: { subagent_type: 'reviewer' } }),
	];
	const summaries = groupInvocationsByType(extractSubagentInvocations(timeline));
	const explore = summaries.find((s) => s.subagentType === 'Explore');
	const reviewer = summaries.find((s) => s.subagentType === 'reviewer');

	assert.equal(explore?.invocationCount, 2);
	assert.equal(explore?.isRepeatCandidate, true);
	assert.equal(reviewer?.invocationCount, 1);
	assert.equal(reviewer?.isRepeatCandidate, false);
});

test('invocations with no resolvable subagent_type stay separate singletons, never merged', () => {
	const timeline = [
		makeCall({ toolUseId: 'toolu_1', input: {} }),
		makeCall({ toolUseId: 'toolu_2', input: {} }),
	];
	const summaries = groupInvocationsByType(extractSubagentInvocations(timeline));
	const unknownSummaries = summaries.filter((s) => s.subagentType === undefined);

	assert.equal(unknownSummaries.length, 2);
	assert.ok(unknownSummaries.every((s) => s.invocationCount === 1 && !s.isRepeatCandidate));
});

test('computeAgentUsageStats wires extraction and grouping together', () => {
	const timeline = [makeCall({ toolUseId: 'toolu_1' })];
	const stats = computeAgentUsageStats(timeline);
	assert.equal(stats.invocations.length, 1);
	assert.equal(stats.byType.length, 1);
});
