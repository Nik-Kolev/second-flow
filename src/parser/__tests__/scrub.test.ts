import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scrubDeep, scrubText } from '../scrub.js';

test('scrubText redacts an Anthropic API key', () => {
	const input = 'my key is sk-ant-api03-abcdefghij1234567890 please keep it safe';
	assert.equal(scrubText(input), 'my key is [REDACTED:anthropic-key] please keep it safe');
});

test('scrubText redacts a Bearer token', () => {
	const input = 'Authorization: Bearer abc123.def456-ghi789';
	assert.equal(scrubText(input), 'Authorization: Bearer [REDACTED]');
});

test('scrubText redacts a named secret assignment regardless of prefix', () => {
	assert.equal(scrubText('ANTHROPIC_API_KEY=sk-ant-something'), 'ANTHROPIC_API_KEY=[REDACTED]');
	assert.equal(scrubText('STRIPE_SECRET_KEY=sk_live_abcdef'), 'STRIPE_SECRET_KEY=[REDACTED]');
});

test('scrubText redacts a generic long .env-style assignment', () => {
	const input = 'SOME_RANDOM_VALUE=aGVsbG93b3JsZHRoaXNpc2xvbmc';
	assert.equal(scrubText(input), 'SOME_RANDOM_VALUE=[REDACTED]');
});

test('scrubText leaves ordinary text untouched', () => {
	const input = 'just a normal sentence about fixing the parser';
	assert.equal(scrubText(input), input);
});

test('scrubDeep walks nested objects and arrays', () => {
	const input = {
		note: 'sk-ant-api03-abcdefghij1234567890',
		nested: { list: ['Bearer abc123def456', 'fine'] },
	};
	const result = scrubDeep(input);
	assert.equal(result.note, '[REDACTED:anthropic-key]');
	assert.equal(result.nested.list[0], 'Bearer [REDACTED]');
	assert.equal(result.nested.list[1], 'fine');
});
