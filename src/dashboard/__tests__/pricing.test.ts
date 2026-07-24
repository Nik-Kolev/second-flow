import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeCallCostUsd, computeTotalSpendUsd, PRICING_PER_MTOK } from '../pricing.js';

test('computeCallCostUsd computes exact USD for a known haiku call', () => {
	const cost = computeCallCostUsd({
		model: 'claude-haiku-4-5',
		inputTokens: 1_000_000,
		outputTokens: 1_000_000,
		cacheReadTokens: 1_000_000,
		cacheCreationTokens: 1_000_000,
	});
	const pricing = PRICING_PER_MTOK['claude-haiku-4-5']!;

	assert.equal(cost, pricing.input + pricing.output + pricing.cacheRead + pricing.cacheWrite);
});

test('computeCallCostUsd computes exact USD for a known sonnet call', () => {
	const cost = computeCallCostUsd({
		model: 'claude-sonnet-5',
		inputTokens: 500_000,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
	});

	assert.equal(cost, PRICING_PER_MTOK['claude-sonnet-5']!.input * 0.5);
});

test('computeCallCostUsd returns 0 for an unrecognized model string', () => {
	const cost = computeCallCostUsd({
		model: 'claude-unknown-model',
		inputTokens: 1_000_000,
		outputTokens: 1_000_000,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
	});

	assert.equal(cost, 0);
});

test('computeTotalSpendUsd sums cost across multiple calls', () => {
	const total = computeTotalSpendUsd([
		{
			model: 'claude-haiku-4-5',
			inputTokens: 1_000_000,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
		},
		{
			model: 'claude-sonnet-5',
			inputTokens: 1_000_000,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
		},
	]);

	assert.equal(
		total,
		PRICING_PER_MTOK['claude-haiku-4-5']!.input + PRICING_PER_MTOK['claude-sonnet-5']!.input,
	);
});

test('computeTotalSpendUsd returns 0 for an empty array', () => {
	assert.equal(computeTotalSpendUsd([]), 0);
});
