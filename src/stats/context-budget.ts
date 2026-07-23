import type { AssistantTurnEvent, TimelineEvent, UsageInfo } from '../parser/index.js';
import type { ContextBudgetPoint } from './types.js';

// Hand-maintained, keyed by the exact `model` string the API returns — staleness risk, not
// sourced from any API. Left empty until real figures are verified against Anthropic's docs.
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {};

export function turnContextTokens(usage: UsageInfo): number {
	// The Messages API is stateless and resends the full conversation every call, so a turn's own
	// usage numbers are already that turn's whole context — summing across turns would double-count.
	return (
		usage.inputTokens +
		(usage.cacheReadInputTokens ?? 0) +
		(usage.cacheCreationInputTokens ?? 0)
	);
}

export function computeContextBudgetSeries(timeline: TimelineEvent[]): ContextBudgetPoint[] {
	const turns = timeline.filter(
		(event): event is AssistantTurnEvent => event.kind === 'assistant-turn',
	);
	return turns.map((turn, turnIndex) => {
		const contextTokens = turnContextTokens(turn.usage);
		const contextWindowSize = MODEL_CONTEXT_WINDOWS[turn.model];
		return {
			turnIndex,
			messageId: turn.messageId,
			timestamp: turn.timestamp,
			model: turn.model,
			contextTokens,
			contextWindowSize,
			percentConsumed: contextWindowSize ? contextTokens / contextWindowSize : undefined,
		};
	});
}
