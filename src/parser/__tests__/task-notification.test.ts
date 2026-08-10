import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTaskNotification } from '../task-notification.js';

test('parses a completed subagent task-notification', () => {
	const content =
		'<task-notification>\n<task-id>abc123</task-id>\n<tool-use-id>toolu_01ABC</tool-use-id>\n<output-file>C:\\out.txt</output-file>\n<status>completed</status>\n<summary>Agent "Test" finished</summary>\n<result>Here is the finding.</result>\n<usage><subagent_tokens>1234</subagent_tokens><tool_uses>5</tool_uses><duration_ms>6789</duration_ms></usage>\n</task-notification>';

	const info = parseTaskNotification(content);
	assert.ok(info);
	assert.equal(info?.toolUseId, 'toolu_01ABC');
	assert.equal(info?.status, 'completed');
	assert.equal(info?.result, 'Here is the finding.');
	assert.deepEqual(info?.usage, { subagentTokens: 1234, toolUses: 5, durationMs: 6789 });
});

test('the greedy result match survives a literal </result>-looking substring inside the result text', () => {
	const content =
		'<task-notification>\n<tool-use-id>toolu_01XYZ</tool-use-id>\n<status>completed</status>\n<result>Explaining tags: use <result>...</result> to wrap output.</result>\n<usage><subagent_tokens>10</subagent_tokens><tool_uses>1</tool_uses><duration_ms>100</duration_ms></usage>\n</task-notification>';

	const info = parseTaskNotification(content);
	assert.equal(info?.result, 'Explaining tags: use <result>...</result> to wrap output.');
});

test('a background-bash notification with no result/usage still parses the rest', () => {
	const content =
		'<task-notification>\n<task-id>bash1</task-id>\n<tool-use-id>toolu_02BASH</tool-use-id>\n<output-file>C:\\out.txt</output-file>\n<status>completed</status>\n<summary>Background command finished</summary>\n</task-notification>';

	const info = parseTaskNotification(content);
	assert.ok(info);
	assert.equal(info?.result, undefined);
	assert.equal(info?.usage, undefined);
	assert.equal(info?.summary, 'Background command finished');
});

test('tolerates a repeat notification for the same task (resumed background agent)', () => {
	const content =
		'<task-notification>\n<tool-use-id>toolu_repeat</tool-use-id>\n<status>completed</status>\n<result>second answer</result>\n<usage><subagent_tokens>20</subagent_tokens><tool_uses>2</tool_uses><duration_ms>200</duration_ms></usage>\n</task-notification>';

	const info = parseTaskNotification(content);
	assert.equal(info?.result, 'second answer');
});

test('returns null for content that is not a task-notification', () => {
	assert.equal(parseTaskNotification('just a normal message'), null);
});
