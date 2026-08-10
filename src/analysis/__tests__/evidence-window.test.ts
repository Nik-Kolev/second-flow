import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UserMessageEvent } from '../../parser/index.js';
import {
	buildEvidenceSpans,
	extractEvidenceWindow,
	EVIDENCE_WINDOW_RADIUS,
	MAX_SPAN_TRIGGERS_PER_KIND,
	selectSpanTriggers,
	WHOLE_TIMELINE_FALLBACK_THRESHOLD,
} from '../evidence-window.js';

function makeTimeline(length: number): UserMessageEvent[] {
	return Array.from({ length }, (_, i) => ({ kind: 'user-message', text: `turn ${i}` }));
}

const LONG_LENGTH = WHOLE_TIMELINE_FALLBACK_THRESHOLD + 40;

test('selectSpanTriggers keeps every trigger when each kind is under the cap', () => {
	const triggers = [
		{ kind: 'lint-finding', timelineIndex: 1 },
		{ kind: 'lint-finding', timelineIndex: 2 },
		{ kind: 'user-pushback', timelineIndex: 3 },
	];

	assert.deepEqual(selectSpanTriggers(triggers), triggers);
});

test('selectSpanTriggers caps each kind independently', () => {
	const triggers = [
		...Array.from({ length: 40 }, (_, i) => ({ kind: 'lint-finding', timelineIndex: i })),
		{ kind: 'rate-limit-hit', timelineIndex: 100 },
		{ kind: 'rate-limit-hit', timelineIndex: 101 },
	];

	const selected = selectSpanTriggers(triggers);
	const lint = selected.filter((t) => t.kind === 'lint-finding');
	const rateLimit = selected.filter((t) => t.kind === 'rate-limit-hit');

	assert.equal(lint.length, MAX_SPAN_TRIGGERS_PER_KIND);
	assert.equal(rateLimit.length, 2, 'a kind under the cap is never trimmed');
});

test('selectSpanTriggers samples across the whole run, not just the start', () => {
	const triggers = Array.from({ length: 100 }, (_, i) => ({
		kind: 'lint-finding',
		timelineIndex: i,
	}));

	const indices = selectSpanTriggers(triggers).map((t) => t.timelineIndex);

	assert.equal(indices[0], 0, 'the first occurrence is always kept');
	assert.equal(indices[indices.length - 1], 99, 'the last occurrence is always kept');
	assert.ok(
		indices.some((i) => i > 20 && i < 80),
		'the middle of the session must be represented',
	);
});

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
