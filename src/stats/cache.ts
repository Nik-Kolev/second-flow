import type { AssistantTurnEvent, TimelineEvent } from '../parser/index.js';
import { turnContextTokens } from './context-budget.js';
import type { CacheDropEvent, CacheRatioPoint } from './types.js';

export function computeCacheRatioSeries(timeline: TimelineEvent[]): CacheRatioPoint[] {
	const turns = timeline.filter(
		(event): event is AssistantTurnEvent => event.kind === 'assistant-turn',
	);
	return turns.map((turn, turnIndex) => {
		const inputTokens = turn.usage.inputTokens;
		const cacheReadInputTokens = turn.usage.cacheReadInputTokens ?? 0;
		// input_tokens is only the non-cached remainder, not the whole turn — a heavily-cached turn
		// can have input_tokens near 0 while cacheReadInputTokens is huge, so the ratio's denominator
		// has to be the turn's whole context (same total context-budget.ts computes), not inputTokens.
		const totalContextTokens = turnContextTokens(turn.usage);
		return {
			turnIndex,
			messageId: turn.messageId,
			timestamp: turn.timestamp,
			inputTokens,
			cacheReadInputTokens,
			cacheReadRatio:
				totalContextTokens === 0 ? undefined : cacheReadInputTokens / totalContextTokens,
		};
	});
}

// Provisional — needs calibration against real sessions (Core step 9), not a validated constant.
const DEFAULT_DROP_THRESHOLD = 0.2;

function hasCompactBetween(
	timeline: TimelineEvent[],
	fromTimestamp: string,
	toTimestamp: string,
): boolean {
	return timeline.some(
		(event) =>
			event.kind === 'slash-command' &&
			event.commandName === 'compact' &&
			event.timestamp !== undefined &&
			event.timestamp > fromTimestamp &&
			event.timestamp < toTimestamp,
	);
}

export function detectUnexplainedCacheDrops(
	timeline: TimelineEvent[],
	series: CacheRatioPoint[],
	opts?: { dropThreshold?: number },
): CacheDropEvent[] {
	const threshold = opts?.dropThreshold ?? DEFAULT_DROP_THRESHOLD;
	const drops: CacheDropEvent[] = [];

	for (let i = 1; i < series.length; i++) {
		const prev = series[i - 1];
		const curr = series[i];
		if (prev.cacheReadRatio === undefined || curr.cacheReadRatio === undefined) {
			continue;
		}
		const drop = prev.cacheReadRatio - curr.cacheReadRatio;
		if (drop < threshold || hasCompactBetween(timeline, prev.timestamp, curr.timestamp)) {
			continue;
		}
		drops.push({
			fromTurnIndex: prev.turnIndex,
			toTurnIndex: curr.turnIndex,
			fromRatio: prev.cacheReadRatio,
			toRatio: curr.cacheReadRatio,
			drop,
		});
	}

	return drops;
}
