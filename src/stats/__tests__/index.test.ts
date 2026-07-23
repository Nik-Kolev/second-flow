import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ParsedSession, TimelineEvent, UsageInfo } from '../../parser/index.js';
import { computeSessionStats } from '../index.js';

function makeUsage(overrides: Partial<UsageInfo> = {}): UsageInfo {
	return {
		inputTokens: 100,
		outputTokens: 10,
		raw: { input_tokens: 100, output_tokens: 10 },
		...overrides,
	};
}

function makeSession(timeline: TimelineEvent[]): ParsedSession {
	return {
		sessionId: 'sess1',
		projectSlug: 'demo-slug',
		filePath: 'sess1.jsonl',
		timeline,
		attachments: {
			hookSuccess: [],
			skillListing: [],
			deferredToolsDelta: [],
			agentListingDelta: [],
			mcpInstructionsDelta: [],
			outputStyle: [],
			unknown: [],
		},
		noise: { count: 0, byType: {} },
		meta: { aiTitles: [] },
	};
}

test('computeSessionStats wires all six categories together', () => {
	const timeline: TimelineEvent[] = [
		{
			kind: 'assistant-turn',
			messageId: 'm1',
			uuid: 'u1',
			timestamp: 't1',
			model: 'claude-sonnet-5',
			usage: makeUsage({ inputTokens: 100, cacheReadInputTokens: 80 }),
			content: [],
		},
		{
			kind: 'assistant-turn',
			messageId: 'm2',
			uuid: 'u2',
			timestamp: 't2',
			model: '<synthetic>',
			usage: makeUsage({ inputTokens: 0, outputTokens: 0 }),
			content: [],
			rateLimited: true,
			apiErrorStatus: 429,
		},
		{
			kind: 'tool-call',
			toolUseId: 'toolu_commit',
			toolName: 'Bash',
			input: { command: 'git commit -m "msg"' },
			callerUuid: 'u3',
			callTimestamp: 't3',
			isSubagentSpawn: false,
			isBackground: false,
			result: { kind: 'sync', text: 'ok' },
		},
		{
			kind: 'tool-call',
			toolUseId: 'toolu_agent',
			toolName: 'Agent',
			input: { subagent_type: 'Explore' },
			callerUuid: 'u4',
			callTimestamp: 't4',
			isSubagentSpawn: true,
			isBackground: false,
			result: { kind: 'sync', text: 'done' },
		},
	];

	const stats = computeSessionStats(makeSession(timeline));

	assert.equal(stats.sessionId, 'sess1');
	assert.equal(stats.agents.invocations.length, 1);
	assert.equal(stats.contextBudget.length, 2);
	assert.equal(stats.cache.series.length, 2);
	assert.equal(stats.rateLimitHits.length, 1);
	assert.ok(stats.boundaryCandidates.some((c) => c.kind === 'git-commit'));
	assert.ok(stats.boundaryCandidates.some((c) => c.kind === 'subagent-completion'));
});
