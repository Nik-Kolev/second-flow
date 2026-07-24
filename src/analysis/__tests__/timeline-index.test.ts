import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
	AssistantTurnEvent,
	SlashCommandEvent,
	ToolCallEvent,
	UserMessageEvent,
} from '../../parser/index.js';
import { buildTimelineIndex, resolveById, resolveTurnIndex } from '../timeline-index.js';

function makeToolCall(toolUseId: string): ToolCallEvent {
	return {
		kind: 'tool-call',
		toolUseId,
		toolName: 'Bash',
		input: { command: 'echo hi' },
		callerUuid: 'turn-1',
		callTimestamp: 't',
		isSubagentSpawn: false,
		isBackground: false,
		result: { kind: 'sync', text: 'ok' },
	};
}

function makeAssistantTurn(uuid: string): AssistantTurnEvent {
	return {
		kind: 'assistant-turn',
		messageId: `m-${uuid}`,
		uuid,
		timestamp: 't',
		model: 'claude-sonnet-5',
		usage: { inputTokens: 0, outputTokens: 0, raw: { input_tokens: 0, output_tokens: 0 } },
		content: [{ type: 'text', text: 'hi' }],
	};
}

function makeUserMessage(uuid?: string): UserMessageEvent {
	return { kind: 'user-message', uuid, text: 'hello' };
}

function makeSlashCommand(uuid?: string): SlashCommandEvent {
	return { kind: 'slash-command', uuid, commandName: 'compact' };
}

test('byId resolves a tool-call by toolUseId to its raw timeline index', () => {
	const timeline = [makeUserMessage('u1'), makeToolCall('call-a')];
	const index = buildTimelineIndex(timeline);

	assert.equal(resolveById(index, 'call-a'), 1);
});

test('byId resolves an assistant-turn, user-message, and slash-command by uuid', () => {
	const timeline = [makeUserMessage('u1'), makeAssistantTurn('turn-1'), makeSlashCommand('s1')];
	const index = buildTimelineIndex(timeline);

	assert.equal(resolveById(index, 'u1'), 0);
	assert.equal(resolveById(index, 'turn-1'), 1);
	assert.equal(resolveById(index, 's1'), 2);
});

test('a user-message/slash-command with no uuid is simply not indexed', () => {
	const timeline = [makeUserMessage(undefined), makeSlashCommand(undefined)];
	const index = buildTimelineIndex(timeline);

	assert.equal(index.byId.size, 0);
});

test('resolveById returns undefined for an id never seen', () => {
	const index = buildTimelineIndex([makeToolCall('call-a')]);

	assert.equal(resolveById(index, 'never-seen'), undefined);
});

test('assistantTurnRawIndices maps the Nth assistant-turn back to its raw index in a mixed timeline', () => {
	const timeline = [
		makeUserMessage('u1'),
		makeAssistantTurn('turn-1'),
		makeToolCall('call-a'),
		makeToolCall('call-b'),
		makeAssistantTurn('turn-2'),
	];
	const index = buildTimelineIndex(timeline);

	assert.equal(resolveTurnIndex(index, 0), 1);
	assert.equal(resolveTurnIndex(index, 1), 4);
});

test('resolveTurnIndex returns undefined for an out-of-range turn index', () => {
	const index = buildTimelineIndex([makeAssistantTurn('turn-1')]);

	assert.equal(resolveTurnIndex(index, 5), undefined);
});
