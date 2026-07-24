import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
	AssistantContentBlock,
	AssistantTurnEvent,
	ToolCallEvent,
} from '../../parser/index.js';
import { checkShellCommandLabel } from '../shell-command-label.js';

function makeTurn(uuid: string, content: AssistantContentBlock[]): AssistantTurnEvent {
	return {
		kind: 'assistant-turn',
		messageId: `msg_${uuid}`,
		uuid,
		timestamp: 't',
		model: 'claude-sonnet-5',
		usage: { inputTokens: 0, outputTokens: 0, raw: { input_tokens: 0, output_tokens: 0 } },
		content,
	};
}

function makeShellCall(
	toolUseId: string,
	callerUuid: string,
	overrides: Partial<ToolCallEvent> = {},
): ToolCallEvent {
	return {
		kind: 'tool-call',
		toolUseId,
		toolName: 'Bash',
		input: { command: 'npm test' },
		callerUuid,
		callTimestamp: 't',
		isSubagentSpawn: false,
		isBackground: false,
		result: { kind: 'sync', text: 'ok' },
		...overrides,
	};
}

test('a shell call with an immediately preceding RUNNING: label produces no finding', () => {
	const timeline = [
		makeTurn('u1', [
			{ type: 'text', text: 'RUNNING: run the test suite' },
			{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'npm test' } },
		]),
		makeShellCall('a', 'u1'),
	];

	assert.deepEqual(checkShellCommandLabel(timeline), []);
});

test('a shell call with no preceding text block produces a finding', () => {
	const timeline = [
		makeTurn('u1', [
			{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'npm test' } },
		]),
		makeShellCall('a', 'u1'),
	];

	const findings = checkShellCommandLabel(timeline);

	assert.equal(findings.length, 1);
	assert.equal(findings[0].checkerId, 'shell-command-label');
	assert.equal(findings[0].toolUseId, 'a');
	assert.equal(findings[0].evidence, 'npm test');
});

test('a shell call preceded by unrelated text produces a finding', () => {
	const timeline = [
		makeTurn('u1', [
			{ type: 'text', text: "I'll run the tests now." },
			{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'npm test' } },
		]),
		makeShellCall('a', 'u1'),
	];

	assert.equal(checkShellCommandLabel(timeline).length, 1);
});

test('a PowerShell call is checked the same as a Bash call', () => {
	const timeline = [
		makeTurn('u1', [
			{ type: 'tool_use', id: 'a', name: 'PowerShell', input: { command: 'ls' } },
		]),
		makeShellCall('a', 'u1', { toolName: 'PowerShell', input: { command: 'ls' } }),
	];

	assert.equal(checkShellCommandLabel(timeline).length, 1);
});

test('two shell calls in the same turn each need their own label', () => {
	const timeline = [
		makeTurn('u1', [
			{ type: 'text', text: 'RUNNING: list files' },
			{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'ls' } },
			{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'pwd' } },
		]),
		makeShellCall('a', 'u1', { input: { command: 'ls' } }),
		makeShellCall('b', 'u1', { input: { command: 'pwd' } }),
	];

	const findings = checkShellCommandLabel(timeline);

	assert.equal(findings.length, 1);
	assert.equal(findings[0].toolUseId, 'b');
});

test('a non-shell tool call is never checked', () => {
	const timeline = [
		makeTurn('u1', [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'x.ts' } }]),
		makeShellCall('a', 'u1', { toolName: 'Read', input: { file_path: 'x.ts' } }),
	];

	assert.deepEqual(checkShellCommandLabel(timeline), []);
});

test('a call whose caller turn cannot be found is treated as unlabeled', () => {
	const timeline = [makeShellCall('a', 'missing-uuid')];

	assert.equal(checkShellCommandLabel(timeline).length, 1);
});
