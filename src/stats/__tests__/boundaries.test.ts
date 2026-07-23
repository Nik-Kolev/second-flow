import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ToolCallEvent } from '../../parser/index.js';
import { detectBoundaryCandidates } from '../boundaries.js';

function makeBashCall(command: string, toolUseId = 'toolu_bash'): ToolCallEvent {
	return {
		kind: 'tool-call',
		toolUseId,
		toolName: 'Bash',
		input: { command },
		callerUuid: 'u1',
		callTimestamp: 't1',
		isSubagentSpawn: false,
		isBackground: false,
		result: { kind: 'sync', text: 'ok' },
	};
}

function makeAgentCall(overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
	return {
		kind: 'tool-call',
		toolUseId: 'toolu_agent',
		toolName: 'Agent',
		input: { subagent_type: 'Explore' },
		callerUuid: 'u1',
		callTimestamp: 't1',
		isSubagentSpawn: true,
		isBackground: false,
		result: { kind: 'pending' },
		...overrides,
	};
}

test('git commit, git push, and gh pr create are each matched', () => {
	const timeline = [
		makeBashCall('git commit -m "msg"', 'a'),
		makeBashCall('git push origin main', 'b'),
		makeBashCall('gh pr create --title x', 'c'),
	];

	const candidates = detectBoundaryCandidates(timeline);

	assert.equal(candidates.filter((c) => c.kind === 'git-commit').length, 1);
	assert.equal(candidates.filter((c) => c.kind === 'git-push').length, 1);
	assert.equal(candidates.filter((c) => c.kind === 'gh-pr-create').length, 1);
});

test('an unrelated Bash command produces no candidates', () => {
	const timeline = [makeBashCall('npm test')];

	assert.equal(detectBoundaryCandidates(timeline).length, 0);
});

test('a sync-resolved subagent spawn is a completion candidate', () => {
	const timeline = [makeAgentCall({ result: { kind: 'sync', text: 'done' } })];

	const candidates = detectBoundaryCandidates(timeline);

	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].kind, 'subagent-completion');
});

test('completed and failed async subagent results are both completion candidates', () => {
	const timeline = [
		makeAgentCall({
			toolUseId: 'a',
			result: { kind: 'async-task-notification', status: 'completed' },
		}),
		makeAgentCall({
			toolUseId: 'b',
			result: { kind: 'async-task-notification', status: 'failed' },
		}),
	];

	assert.equal(detectBoundaryCandidates(timeline).length, 2);
});

test('a pending subagent spawn is not a completion candidate', () => {
	const timeline = [makeAgentCall({ result: { kind: 'pending' } })];

	assert.equal(detectBoundaryCandidates(timeline).length, 0);
});
