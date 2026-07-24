import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SlashCommandEvent, ToolCallEvent } from '../../parser/index.js';
import { checkBoundaryFollowedByCompact } from '../boundary-compact.js';

function makeShellCall(toolUseId: string, command: string, timestamp: string): ToolCallEvent {
	return {
		kind: 'tool-call',
		toolUseId,
		toolName: 'Bash',
		input: { command },
		callerUuid: 'u1',
		callTimestamp: timestamp,
		isSubagentSpawn: false,
		isBackground: false,
		result: { kind: 'sync', text: 'ok' },
	};
}

function makeSubagentCompletion(toolUseId: string, timestamp: string): ToolCallEvent {
	return {
		kind: 'tool-call',
		toolUseId,
		toolName: 'Agent',
		input: {},
		callerUuid: 'u1',
		callTimestamp: timestamp,
		isSubagentSpawn: true,
		isBackground: false,
		result: { kind: 'sync', timestamp, text: 'done' },
	};
}

function makeCompact(timestamp: string): SlashCommandEvent {
	return { kind: 'slash-command', commandName: 'compact', timestamp };
}

test('a boundary with no following compact produces a finding', () => {
	const timeline = [makeShellCall('a', 'git commit -m "x"', 't1')];

	const findings = checkBoundaryFollowedByCompact(timeline);

	assert.equal(findings.length, 1);
	assert.equal(findings[0].checkerId, 'boundary-compact');
	assert.equal(findings[0].toolUseId, 'a');
});

test('a boundary followed by a compact produces no finding', () => {
	const timeline = [makeShellCall('a', 'git commit -m "x"', 't1'), makeCompact('t2')];

	assert.deepEqual(checkBoundaryFollowedByCompact(timeline), []);
});

test('a compact before the boundary does not count — only a later one clears it', () => {
	const timeline = [makeCompact('t1'), makeShellCall('a', 'git commit -m "x"', 't2')];

	assert.equal(checkBoundaryFollowedByCompact(timeline).length, 1);
});

test('a subagent completion not followed by a compact produces a finding', () => {
	const timeline = [makeSubagentCompletion('a', 't1')];

	const findings = checkBoundaryFollowedByCompact(timeline);

	assert.equal(findings.length, 1);
	assert.equal(findings[0].toolUseId, 'a');
});

test('two sequential boundaries: a compact between them only clears the first', () => {
	const timeline = [
		makeShellCall('a', 'git commit -m "x"', 't1'),
		makeCompact('t2'),
		makeShellCall('b', 'git commit -m "y"', 't3'),
	];

	const findings = checkBoundaryFollowedByCompact(timeline);

	assert.equal(findings.length, 1);
	assert.equal(findings[0].toolUseId, 'b');
});

test('a compound command producing two same-timestamp boundaries shares one window: both cleared', () => {
	const timeline = [makeShellCall('a', 'git commit -m "x" && git push', 't1'), makeCompact('t2')];

	assert.deepEqual(checkBoundaryFollowedByCompact(timeline), []);
});

test('a compound command producing two same-timestamp boundaries: both flagged with no compact', () => {
	const timeline = [makeShellCall('a', 'git commit -m "x" && git push', 't1')];

	const findings = checkBoundaryFollowedByCompact(timeline);

	assert.equal(findings.length, 2);
	assert.ok(findings.every((finding) => finding.toolUseId === 'a'));
});
