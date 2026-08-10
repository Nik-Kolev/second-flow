import type { AssistantTurnEvent, TimelineEvent } from '../parser/index.js';
import type { RateLimitHit } from './types.js';

export function computeRateLimitHits(timeline: TimelineEvent[]): RateLimitHit[] {
	const turns = timeline.filter(
		(event): event is AssistantTurnEvent => event.kind === 'assistant-turn',
	);
	const hits: RateLimitHit[] = [];
	turns.forEach((turn, turnIndex) => {
		if (turn.rateLimited === true) {
			hits.push({
				turnIndex,
				messageId: turn.messageId,
				timestamp: turn.timestamp,
				apiErrorStatus: turn.apiErrorStatus,
			});
		}
	});
	return hits;
}
