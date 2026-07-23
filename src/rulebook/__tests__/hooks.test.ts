import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractHookRuleBlocks } from '../hooks.js';
import type { HookSuccessAttachment } from '../types.js';

test('extracts a block from a SessionStart hook with content', () => {
	const hookSuccess: HookSuccessAttachment[] = [
		{
			hookName: 'SessionStart:clear',
			hookEvent: 'SessionStart',
			content: '=== Level 1: global memory index ===',
			uuid: 'u1',
			timestamp: 't1',
		},
	];

	const blocks = extractHookRuleBlocks(hookSuccess);

	assert.equal(blocks.length, 1);
	assert.equal(blocks[0].origin, 'hook');
	assert.equal(blocks[0].layer, 'user');
	assert.equal(blocks[0].text, '=== Level 1: global memory index ===');
	assert.equal(blocks[0].source, 'SessionStart:clear');
});

test('falls back to stdout when content is absent', () => {
	const hookSuccess: HookSuccessAttachment[] = [
		{ hookEvent: 'SessionStart', stdout: 'from stdout' },
	];

	const blocks = extractHookRuleBlocks(hookSuccess);

	assert.equal(blocks.length, 1);
	assert.equal(blocks[0].text, 'from stdout');
});

test('ignores hook events other than SessionStart', () => {
	const hookSuccess: HookSuccessAttachment[] = [
		{ hookEvent: 'PreToolUse', content: 'some pre-tool-use output' },
	];

	assert.deepEqual(extractHookRuleBlocks(hookSuccess), []);
});

test('ignores entries with no content or stdout', () => {
	const hookSuccess: HookSuccessAttachment[] = [{ hookEvent: 'SessionStart' }];
	assert.deepEqual(extractHookRuleBlocks(hookSuccess), []);
});

test('falls back to stdout when content is an empty string, not just absent', () => {
	const hookSuccess: HookSuccessAttachment[] = [
		{ hookEvent: 'SessionStart', content: '', stdout: 'important injected rules' },
	];

	const blocks = extractHookRuleBlocks(hookSuccess);

	assert.equal(blocks.length, 1);
	assert.equal(blocks[0].text, 'important injected rules');
});

test('ignores blank content/stdout', () => {
	const hookSuccess: HookSuccessAttachment[] = [
		{ hookEvent: 'SessionStart', content: '   ', stdout: '' },
	];
	assert.deepEqual(extractHookRuleBlocks(hookSuccess), []);
});

test('does not deduplicate two identical SessionStart firings', () => {
	const hookSuccess: HookSuccessAttachment[] = [
		{ hookEvent: 'SessionStart', content: 'same text', uuid: 'u1' },
		{ hookEvent: 'SessionStart', content: 'same text', uuid: 'u2' },
	];

	const blocks = extractHookRuleBlocks(hookSuccess);
	assert.equal(blocks.length, 2);
});
