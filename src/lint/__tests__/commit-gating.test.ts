import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
	AssistantTurnEvent,
	SlashCommandEvent,
	ToolCallEvent,
	UserMessageEvent,
} from '../../parser/index.js';
import { checkCommitGating } from '../commit-gating.js';

function makeCommitCall(toolUseId: string, command = 'git commit -m "x"'): ToolCallEvent {
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
	};
}

function makeUserMessage(text = 'commit'): UserMessageEvent {
	return { kind: 'user-message', text };
}

function makeSlashCommand(commandName = 'wrap-up'): SlashCommandEvent {
	return { kind: 'slash-command', commandName };
}

function makeAssistantTurn(text: string): AssistantTurnEvent {
	return {
		kind: 'assistant-turn',
		messageId: 'm1',
		uuid: 'u1',
		timestamp: 't',
		model: 'claude-sonnet-5',
		usage: { inputTokens: 0, outputTokens: 0, raw: { input_tokens: 0, output_tokens: 0 } },
		content: [{ type: 'text', text }],
	};
}

test('a commit preceded by a user turn produces no finding', () => {
	const timeline = [makeUserMessage('commit'), makeCommitCall('a')];

	assert.deepEqual(checkCommitGating(timeline), []);
});

test('a commit with no preceding user turn at all produces a finding', () => {
	const timeline = [makeCommitCall('a')];

	const findings = checkCommitGating(timeline);

	assert.equal(findings.length, 1);
	assert.equal(findings[0].checkerId, 'commit-gating');
	assert.equal(findings[0].toolUseId, 'a');
});

test('assistant text alone, with no user turn, still produces a finding', () => {
	const timeline = [makeAssistantTurn('Proposing this commit message...'), makeCommitCall('a')];

	assert.equal(checkCommitGating(timeline).length, 1);
});

test('a slash command counts as a user turn, same as a plain message', () => {
	const timeline = [makeSlashCommand('wrap-up'), makeCommitCall('a')];

	assert.deepEqual(checkCommitGating(timeline), []);
});

test('the approval requirement resets after each commit', () => {
	const timeline = [makeUserMessage('commit'), makeCommitCall('a'), makeCommitCall('b')];

	const findings = checkCommitGating(timeline);

	assert.equal(findings.length, 1);
	assert.equal(findings[0].toolUseId, 'b');
});

test('two approved commits in a row are both fine', () => {
	const timeline = [
		makeUserMessage('commit'),
		makeCommitCall('a'),
		makeUserMessage('commit again'),
		makeCommitCall('b'),
	];

	assert.deepEqual(checkCommitGating(timeline), []);
});

test('a timeline with no commits produces no findings', () => {
	const timeline = [makeUserMessage('hello')];

	assert.deepEqual(checkCommitGating(timeline), []);
});
