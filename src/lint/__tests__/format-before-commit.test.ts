import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ToolCallEvent } from '../../parser/index.js';
import { checkFormatBeforeCommit } from '../format-before-commit.js';

function makeCall(
	toolUseId: string,
	command: string,
	overrides: Partial<ToolCallEvent> = {},
): ToolCallEvent {
	return {
		kind: 'tool-call',
		toolUseId,
		toolName: 'Bash',
		input: { command },
		callerUuid: 'u1',
		callTimestamp: 't',
		isSubagentSpawn: false,
		isBackground: false,
		result: { kind: 'sync', text: 'ok' },
		...overrides,
	};
}

test('a commit preceded by a format command produces no finding', () => {
	const timeline = [
		makeCall('a', 'npm run format'),
		makeCall('b', 'git commit -m "add feature"'),
	];

	assert.deepEqual(checkFormatBeforeCommit(timeline), []);
});

test('a commit with no preceding format command produces a finding', () => {
	const timeline = [makeCall('a', 'git commit -m "add feature"')];

	const findings = checkFormatBeforeCommit(timeline);

	assert.equal(findings.length, 1);
	assert.equal(findings[0].checkerId, 'format-before-commit');
	assert.equal(findings[0].toolUseId, 'a');
});

test('a single compound format-then-commit call self-satisfies', () => {
	const timeline = [makeCall('a', 'prettier --write . && git commit -m "x"')];

	assert.deepEqual(checkFormatBeforeCommit(timeline), []);
});

test('the format requirement resets after each commit', () => {
	const timeline = [
		makeCall('a', 'npm run format'),
		makeCall('b', 'git commit -m "first"'),
		makeCall('c', 'git commit -m "second"'),
	];

	const findings = checkFormatBeforeCommit(timeline);

	assert.equal(findings.length, 1);
	assert.equal(findings[0].toolUseId, 'c');
});

test('a format command run via PowerShell also counts', () => {
	const timeline = [
		makeCall('a', 'prettier --write .', { toolName: 'PowerShell' }),
		makeCall('b', 'git commit -m "x"'),
	];

	assert.deepEqual(checkFormatBeforeCommit(timeline), []);
});

test('--fix alone counts as a format action', () => {
	const timeline = [makeCall('a', 'eslint . --fix'), makeCall('b', 'git commit -m "x"')];

	assert.deepEqual(checkFormatBeforeCommit(timeline), []);
});

test('a timeline with no commits produces no findings', () => {
	const timeline = [makeCall('a', 'npm test')];

	assert.deepEqual(checkFormatBeforeCommit(timeline), []);
});
