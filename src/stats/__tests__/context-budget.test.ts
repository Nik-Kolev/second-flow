import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssistantTurnEvent, UsageInfo } from '../../parser/index.js';
import { computeContextBudgetSeries, MODEL_CONTEXT_WINDOWS } from '../context-budget.js';

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

test('a known model resolves percentConsumed from the context-window table', () => {
	MODEL_CONTEXT_WINDOWS['test-model-known'] = 1000;
	const timeline = [
		makeTurn({ model: 'test-model-known', usage: makeUsage({ inputTokens: 250 }) }),
	];

	const [point] = computeContextBudgetSeries(timeline);

	assert.equal(point.contextTokens, 250);
	assert.equal(point.percentConsumed, 0.25);
});

test('an unlisted model reports contextTokens but leaves percentConsumed undefined', () => {
	const timeline = [
		makeTurn({ model: 'totally-unknown-model', usage: makeUsage({ inputTokens: 250 }) }),
	];

	const [point] = computeContextBudgetSeries(timeline);

	assert.equal(point.contextTokens, 250);
	assert.equal(point.percentConsumed, undefined);
});

test('the rate-limit sentinel model never resolves a percentage', () => {
	const timeline = [
		makeTurn({ model: '<synthetic>', usage: makeUsage({ inputTokens: 0, outputTokens: 0 }) }),
	];

	const [point] = computeContextBudgetSeries(timeline);

	assert.equal(point.percentConsumed, undefined);
});

test("contextTokens is each turn's own total, not summed across turns", () => {
	MODEL_CONTEXT_WINDOWS['test-model-cumulative'] = 1000;
	const timeline = [
		makeTurn({
			messageId: 'm1',
			model: 'test-model-cumulative',
			usage: makeUsage({ inputTokens: 100, cacheReadInputTokens: 50 }),
		}),
		makeTurn({
			messageId: 'm2',
			model: 'test-model-cumulative',
			usage: makeUsage({ inputTokens: 200, cacheReadInputTokens: 100 }),
		}),
	];

	const points = computeContextBudgetSeries(timeline);

	assert.equal(points[0].contextTokens, 150);
	assert.equal(points[1].contextTokens, 300);
});
