import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
	AssistantTurnEvent,
	SlashCommandEvent,
	TimelineEvent,
	UsageInfo,
} from '../../parser/index.js';
import { computeCacheRatioSeries, detectUnexplainedCacheDrops } from '../cache.js';

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

function makeCompact(timestamp: string): SlashCommandEvent {
	return { kind: 'slash-command', commandName: 'compact', timestamp };
}

test('computeCacheRatioSeries ratios cache reads against the whole turn, not just inputTokens, and is undefined when the turn has no context at all', () => {
	const timeline = [
		makeTurn({
			messageId: 'm1',
			usage: makeUsage({ inputTokens: 100, cacheReadInputTokens: 40 }),
		}),
		makeTurn({
			messageId: 'm2',
			usage: makeUsage({ inputTokens: 0, cacheReadInputTokens: 0 }),
		}),
	];

	const series = computeCacheRatioSeries(timeline);

	// 40 / (100 inputTokens + 40 cacheRead + 0 cacheCreate) = 40/140, not 40/100 — a heavily-cached
	// turn can have inputTokens near 0 while cacheReadInputTokens is huge, so the ratio must be
	// against the turn's whole context, never inputTokens alone (verified against a real transcript).
	assert.equal(series[0].cacheReadRatio, 40 / 140);
	assert.equal(series[1].cacheReadRatio, undefined);
});

test('a drop above threshold with no compact in the gap is unexplained', () => {
	const timeline: TimelineEvent[] = [
		makeTurn({
			messageId: 'm1',
			timestamp: 't1',
			usage: makeUsage({ inputTokens: 100, cacheReadInputTokens: 80 }),
		}),
		makeTurn({
			messageId: 'm2',
			timestamp: 't2',
			usage: makeUsage({ inputTokens: 100, cacheReadInputTokens: 10 }),
		}),
	];

	const drops = detectUnexplainedCacheDrops(timeline, computeCacheRatioSeries(timeline));

	assert.equal(drops.length, 1);
	assert.equal(drops[0].fromTurnIndex, 0);
	assert.equal(drops[0].toTurnIndex, 1);
});

test('the same drop is excluded when a /compact sits in the gap', () => {
	const timeline: TimelineEvent[] = [
		makeTurn({
			messageId: 'm1',
			timestamp: 't1',
			usage: makeUsage({ inputTokens: 100, cacheReadInputTokens: 80 }),
		}),
		makeCompact('t1b'),
		makeTurn({
			messageId: 'm2',
			timestamp: 't2',
			usage: makeUsage({ inputTokens: 100, cacheReadInputTokens: 10 }),
		}),
	];

	const drops = detectUnexplainedCacheDrops(timeline, computeCacheRatioSeries(timeline));

	assert.equal(drops.length, 0);
});

test('a drop below the threshold is not flagged at all', () => {
	const timeline: TimelineEvent[] = [
		makeTurn({
			messageId: 'm1',
			timestamp: 't1',
			usage: makeUsage({ inputTokens: 100, cacheReadInputTokens: 80 }),
		}),
		makeTurn({
			messageId: 'm2',
			timestamp: 't2',
			usage: makeUsage({ inputTokens: 100, cacheReadInputTokens: 75 }),
		}),
	];

	const drops = detectUnexplainedCacheDrops(timeline, computeCacheRatioSeries(timeline));

	assert.equal(drops.length, 0);
});
