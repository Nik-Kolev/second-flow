import type { TimelineEvent } from '../parser/index.js';

// Two lookup styles, because upstream signals reference a trigger turn two different ways:
// rate-limit hits / cache-ratio points / cache drops / context-budget points carry a `turnIndex`
// scoped to assistant-turns only (see stats/*.ts's `turns.forEach((turn, turnIndex) => ...)`
// pattern) — not a `uuid`. Boundary candidates / lint findings / subagent invocations carry only
// a `toolUseId`. Nothing in the parser or stats layer maps either back to a raw `timeline` index.
export interface TimelineIndex {
	byId: Map<string, number>;
	assistantTurnRawIndices: number[];
}

export function buildTimelineIndex(timeline: TimelineEvent[]): TimelineIndex {
	const byId = new Map<string, number>();
	const assistantTurnRawIndices: number[] = [];

	timeline.forEach((event, rawIndex) => {
		if (event.kind === 'tool-call') {
			byId.set(event.toolUseId, rawIndex);
			return;
		}
		if (event.kind === 'assistant-turn') {
			assistantTurnRawIndices.push(rawIndex);
			byId.set(event.uuid, rawIndex);
			return;
		}
		if (event.kind === 'user-message' || event.kind === 'slash-command') {
			if (event.uuid !== undefined) {
				byId.set(event.uuid, rawIndex);
			}
		}
	});

	return { byId, assistantTurnRawIndices };
}

export function resolveById(index: TimelineIndex, id: string): number | undefined {
	return index.byId.get(id);
}

export function resolveTurnIndex(index: TimelineIndex, turnIndex: number): number | undefined {
	return index.assistantTurnRawIndices[turnIndex];
}
