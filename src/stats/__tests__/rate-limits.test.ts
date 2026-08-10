import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssistantTurnEvent, UsageInfo } from '../../parser/index.js';
import { computeRateLimitHits } from '../rate-limits.js';

function makeUsage(overrides: Partial<UsageInfo> = {}): UsageInfo {
	return {
		inputTokens: 100,
		outputTokens: 10,
		raw: { input_tokens: 100, output_tokens: 10 },
		...overrides,
	};
}

function makeTurn(overrides: Partial<AssistantTurnEvent> = {}): AssistantTurnEvent {
	return {
		kind: 'assistant-turn',
		messageId: 'm1',
		uuid: 'u1',
		timestamp: 't1',
		model: 'claude-sonnet-5',
		usage: makeUsage(),
		content: [],
		...overrides,
	};
}

test('a rate-limited turn is included with its apiErrorStatus', () => {
	const timeline = [
		makeTurn({ messageId: 'm1' }),
		makeTurn({ messageId: 'm2', rateLimited: true, apiErrorStatus: 429 }),
	];

	const hits = computeRateLimitHits(timeline);

	assert.equal(hits.length, 1);
	assert.equal(hits[0].turnIndex, 1);
	assert.equal(hits[0].messageId, 'm2');
	assert.equal(hits[0].apiErrorStatus, 429);
});

test('ordinary turns are excluded', () => {
	const timeline = [makeTurn({ messageId: 'm1' })];

	assert.equal(computeRateLimitHits(timeline).length, 0);
});
