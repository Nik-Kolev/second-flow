import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UserMessageEvent } from '../../parser/index.js';
import {
	buildEvidenceSpans,
	extractEvidenceWindow,
	EVIDENCE_WINDOW_RADIUS,
	WHOLE_TIMELINE_FALLBACK_THRESHOLD,
} from '../evidence-window.js';

function makeTimeline(length: number): UserMessageEvent[] {
	return Array.from({ length }, (_, i) => ({ kind: 'user-message', text: `turn ${i}` }));
}

const LONG_LENGTH = WHOLE_TIMELINE_FALLBACK_THRESHOLD + 40;

test('zero triggers produces zero spans', () => {
	assert.deepEqual(buildEvidenceSpans(LONG_LENGTH, []), []);
});

test('a timeline at/under the whole-timeline threshold produces one whole-timeline span', () => {
	const spans = buildEvidenceSpans(WHOLE_TIMELINE_FALLBACK_THRESHOLD, [5]);

	assert.deepEqual(spans, [{ start: 0, end: WHOLE_TIMELINE_FALLBACK_THRESHOLD - 1 }]);
});

test('two triggers far apart in a long timeline produce two separate spans', () => {
	const spans = buildEvidenceSpans(LONG_LENGTH, [30, 90]);

	assert.equal(spans.length, 2);
	assert.equal(spans[0].start, 30 - EVIDENCE_WINDOW_RADIUS);
	assert.equal(spans[0].end, 30 + EVIDENCE_WINDOW_RADIUS);
	assert.equal(spans[1].start, 90 - EVIDENCE_WINDOW_RADIUS);
});

test('two triggers within the merge gap produce one merged span', () => {
	// Radius 15 each side; 10 and 40 apart means their raw spans [−5..25] / [25..55] already
	// touch, well within the merge gap.
	const spans = buildEvidenceSpans(LONG_LENGTH, [10, 40]);

	assert.equal(spans.length, 1);
	assert.equal(spans[0].start, 0);
	assert.equal(spans[0].end, 40 + EVIDENCE_WINDOW_RADIUS);
});

test('a trigger near index 0 clips instead of going negative', () => {
	const spans = buildEvidenceSpans(LONG_LENGTH, [2]);

	assert.equal(spans[0].start, 0);
});

test('a trigger near the end clips instead of exceeding the timeline length', () => {
	const spans = buildEvidenceSpans(LONG_LENGTH, [LONG_LENGTH - 2]);

	assert.equal(spans[0].end, LONG_LENGTH - 1);
});

test('extractEvidenceWindow returns events in order with no duplicates across merged spans', () => {
	const timeline = makeTimeline(LONG_LENGTH);
	const spans = buildEvidenceSpans(LONG_LENGTH, [10, 90]);

	const events = extractEvidenceWindow(timeline, spans) as UserMessageEvent[];

	const texts = events.map((event) => event.text);
	assert.equal(new Set(texts).size, texts.length, 'no duplicate events');
	assert.deepEqual(
		texts,
		[...texts].sort((a, b) => Number(a.split(' ')[1]) - Number(b.split(' ')[1])),
		'events remain in original order',
	);
});
