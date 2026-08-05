import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRecords } from '../classify.js';
import type {
	AssistantTurnEvent,
	SlashCommandEvent,
	SystemEvent,
	ToolCallEvent,
	UserMessageEvent,
} from '../types.js';

const context = { sessionId: 'test-session', projectSlug: 'test-project', filePath: 'test.jsonl' };

function line(record: unknown): string {
	return JSON.stringify(record);
}

test('groups a multi-line assistant turn into one event with usage counted once', async () => {
	const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 };
	const lines = [
		line({
			type: 'assistant',
			message: {
				id: 'msg_1',
				model: 'claude-sonnet-5',
				role: 'assistant',
				content: [{ type: 'thinking', thinking: 'hmm' }],
				usage,
			},
			uuid: 'u1',
			timestamp: 't1',
		}),
		line({
			type: 'assistant',
			message: {
				id: 'msg_1',
				model: 'claude-sonnet-5',
				role: 'assistant',
				content: [{ type: 'text', text: 'hello' }],
				usage,
			},
			uuid: 'u1',
			timestamp: 't1',
		}),
	];

	const session = await parseRecords(lines, context);
	const turns = session.timeline.filter(
		(e): e is AssistantTurnEvent => e.kind === 'assistant-turn',
	);

	assert.equal(turns.length, 1);
	assert.equal(turns[0].content.length, 2);
	assert.equal(turns[0].usage.inputTokens, 10);
});

test('resolves an ordinary sync tool call via a matching tool_result', async () => {
	const lines = [
		line({
			type: 'assistant',
			message: {
				id: 'msg_2',
				model: 'claude-sonnet-5',
				role: 'assistant',
				content: [
					{
						type: 'tool_use',
						id: 'toolu_read',
						name: 'Read',
						input: { file_path: 'a.ts' },
					},
				],
				usage: { input_tokens: 1, output_tokens: 1 },
			},
			uuid: 'u2',
			timestamp: 't2',
		}),
		line({
			type: 'user',
			message: {
				role: 'user',
				content: [
					{
						type: 'tool_result',
						tool_use_id: 'toolu_read',
						content: [{ type: 'text', text: 'file contents' }],
					},
				],
			},
			uuid: 'u3',
			timestamp: 't3',
		}),
	];

	const session = await parseRecords(lines, context);
	const call = session.timeline.find((e): e is ToolCallEvent => e.kind === 'tool-call');

	assert.ok(call);
	assert.equal(call?.result.kind, 'sync');
	if (call?.result.kind === 'sync') {
		assert.equal(call.result.text, 'file contents');
	}
});

test('resolves every tool_result block when a turn fires two tool calls and both results land in one record', async () => {
	const lines = [
		line({
			type: 'assistant',
			message: {
				id: 'msg_parallel',
				model: 'claude-sonnet-5',
				role: 'assistant',
				content: [
					{ type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: 'a.ts' } },
				],
				usage: { input_tokens: 1, output_tokens: 1 },
			},
			uuid: 'u_a',
			timestamp: 't_a',
		}),
		line({
			type: 'assistant',
			message: {
				id: 'msg_parallel_2',
				model: 'claude-sonnet-5',
				role: 'assistant',
				content: [
					{ type: 'tool_use', id: 'toolu_b', name: 'Read', input: { file_path: 'b.ts' } },
				],
				usage: { input_tokens: 1, output_tokens: 1 },
			},
			uuid: 'u_b',
			timestamp: 't_b',
		}),
		line({
			type: 'user',
			message: {
				role: 'user',
				content: [
					{
						type: 'tool_result',
						tool_use_id: 'toolu_a',
						content: [{ type: 'text', text: 'contents of a' }],
					},
					{
						type: 'tool_result',
						tool_use_id: 'toolu_b',
						content: [{ type: 'text', text: 'contents of b' }],
					},
				],
			},
			uuid: 'u_result',
			timestamp: 't_result',
		}),
	];

	const session = await parseRecords(lines, context);
	const calls = session.timeline.filter((e): e is ToolCallEvent => e.kind === 'tool-call');
	const callA = calls.find((c) => c.toolUseId === 'toolu_a');
	const callB = calls.find((c) => c.toolUseId === 'toolu_b');

	assert.equal(calls.length, 2);
	assert.equal(callA?.result.kind, 'sync');
	assert.equal(callB?.result.kind, 'sync');
	if (callA?.result.kind === 'sync') assert.equal(callA.result.text, 'contents of a');
	if (callB?.result.kind === 'sync') assert.equal(callB.result.text, 'contents of b');
	assert.equal(session.noise.byType['orphan-tool-result'], undefined);
});

test('an async subagent launch is not resolved by its own "launched" acknowledgment, only by the later task-notification', async () => {
	const lines = [
		line({
			type: 'assistant',
			message: {
				id: 'msg_3',
				model: 'claude-sonnet-5',
				role: 'assistant',
				content: [
					{
						type: 'tool_use',
						id: 'toolu_agent',
						name: 'Agent',
						input: { prompt: 'explore' },
					},
				],
				usage: { input_tokens: 1, output_tokens: 1 },
			},
			uuid: 'u4',
			timestamp: 't4',
		}),
		line({
			type: 'user',
			message: {
				role: 'user',
				content: [
					{
						type: 'tool_result',
						tool_use_id: 'toolu_agent',
						content: [{ type: 'text', text: 'Async agent launched successfully.' }],
					},
				],
			},
			toolUseResult: { isAsync: true, status: 'async_launched' },
			uuid: 'u5',
			timestamp: 't5',
		}),
		line({
			type: 'user',
			message: {
				role: 'user',
				content:
					'<task-notification>\n<task-id>abc</task-id>\n<tool-use-id>toolu_agent</tool-use-id>\n<status>completed</status>\n<result>the real answer</result>\n<usage><subagent_tokens>500</subagent_tokens><tool_uses>3</tool_uses><duration_ms>1000</duration_ms></usage>\n</task-notification>',
			},
			origin: { kind: 'task-notification' },
			uuid: 'u6',
			timestamp: 't6',
		}),
	];

	const session = await parseRecords(lines, context);
	const call = session.timeline.find((e): e is ToolCallEvent => e.kind === 'tool-call');

	assert.ok(call);
	assert.equal(call?.isBackground, true);
	assert.equal(call?.result.kind, 'async-task-notification');
	if (call?.result.kind === 'async-task-notification') {
		assert.equal(call.result.result, 'the real answer');
		assert.equal(call.result.usage?.subagentTokens, 500);
	}
});

test('output_style attachments are deduplicated to first-and-changed values only', async () => {
	const lines = [
		line({
			type: 'attachment',
			attachment: { type: 'output_style', style: 'Explanatory' },
			uuid: 'a1',
			timestamp: 't',
		}),
		line({
			type: 'attachment',
			attachment: { type: 'output_style', style: 'Explanatory' },
			uuid: 'a2',
			timestamp: 't',
		}),
		line({
			type: 'attachment',
			attachment: { type: 'output_style', style: 'Learning' },
			uuid: 'a3',
			timestamp: 't',
		}),
	];

	const session = await parseRecords(lines, context);

	assert.equal(session.attachments.outputStyle.length, 2);
	assert.equal(session.attachments.outputStyle[0].style, 'Explanatory');
	assert.equal(session.attachments.outputStyle[1].style, 'Learning');
	assert.equal(session.noise.byType['attachment:output_style:repeat'], 1);
});

test('an unrecognized attachment type is kept in the unknown bucket, not silently dropped', async () => {
	const lines = [
		line({
			type: 'attachment',
			attachment: { type: 'brand_new_thing' },
			uuid: 'a1',
			timestamp: 't',
		}),
	];

	const session = await parseRecords(lines, context);

	assert.equal(session.attachments.unknown.length, 1);
	assert.equal(session.attachments.unknown[0].attachmentType, 'brand_new_thing');
	assert.equal(session.noise.byType['attachment:brand_new_thing'], 1);
});

test('a stored attachment record never carries the raw attachment.type field', async () => {
	const lines = [
		line({
			type: 'attachment',
			attachment: { type: 'hook_success', hookName: 'SessionStart', stdout: 'loaded' },
			uuid: 'a1',
			timestamp: 't',
		}),
	];

	const session = await parseRecords(lines, context);

	assert.equal(session.attachments.hookSuccess.length, 1);
	assert.ok(
		!('type' in session.attachments.hookSuccess[0]),
		'the raw attachment.type field must not leak onto the typed, stored record',
	);
});

test('an unrecognized top-level record type is counted as noise, never throws', async () => {
	const lines = [line({ type: 'totally-new-record-type', foo: 'bar' })];

	const session = await parseRecords(lines, context);

	assert.equal(session.timeline.length, 0);
	assert.equal(session.noise.byType['unrecognized-type:totally-new-record-type'], 1);
});

test('an unparseable line is skipped, never throws', async () => {
	const lines = ['{not valid json', line({ type: 'ai-title', title: 'My Session' })];

	const session = await parseRecords(lines, context);

	assert.equal(session.noise.byType['unparseable-line'], 1);
	assert.deepEqual(session.meta.aiTitles, ['My Session']);
});

test('a known noise type (e.g. mode) never enters the timeline', async () => {
	const lines = [line({ type: 'mode', mode: 'normal' })];

	const session = await parseRecords(lines, context);

	assert.equal(session.timeline.length, 0);
	assert.equal(session.noise.byType.mode, 1);
});

test('an orphan tool_result (no matching tool_use) is counted as noise, never throws', async () => {
	const lines = [
		line({
			type: 'user',
			message: {
				role: 'user',
				content: [
					{ type: 'tool_result', tool_use_id: 'toolu_missing', content: 'stray result' },
				],
			},
			uuid: 'u1',
			timestamp: 't1',
		}),
	];

	const session = await parseRecords(lines, context);

	assert.equal(session.noise.byType['orphan-tool-result'], 1);
});

test('a slash command is recognized and not treated as a plain chat message', async () => {
	const lines = [
		line({
			type: 'user',
			message: {
				role: 'user',
				content:
					'<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>',
			},
			uuid: 'u1',
			timestamp: 't1',
		}),
	];

	const session = await parseRecords(lines, context);
	const command = session.timeline.find(
		(e): e is SlashCommandEvent => e.kind === 'slash-command',
	);

	assert.ok(command);
	assert.equal(command?.commandName, '/clear');
});

test('a plain user message is a genuine UserMessageEvent', async () => {
	const lines = [
		line({
			type: 'user',
			message: { role: 'user', content: 'hello there' },
			uuid: 'u1',
			timestamp: 't1',
		}),
	];

	const session = await parseRecords(lines, context);
	const message = session.timeline.find((e): e is UserMessageEvent => e.kind === 'user-message');

	assert.equal(message?.text, 'hello there');
});

test('a system turn_duration record keeps its duration fields', async () => {
	const lines = [
		line({
			type: 'system',
			subtype: 'turn_duration',
			durationMs: 4200,
			messageCount: 3,
			uuid: 's1',
			timestamp: 't1',
		}),
	];

	const session = await parseRecords(lines, context);
	const sys = session.timeline.find((e): e is SystemEvent => e.kind === 'system');

	assert.equal(sys?.durationMs, 4200);
	assert.equal(sys?.messageCount, 3);
});

test('a secret in a system record stdout is scrubbed, like every other timeline path', async () => {
	const lines = [
		line({
			type: 'system',
			subtype: 'local_command',
			content:
				'<local-command-stdout>ANTHROPIC_API_KEY=sk-ant-abcdef1234567890</local-command-stdout>',
			uuid: 's1',
			timestamp: 't1',
		}),
	];

	const session = await parseRecords(lines, context);
	const sys = session.timeline.find((e): e is SystemEvent => e.kind === 'system');
	const rawContent = (sys?.raw as { content?: string } | undefined)?.content ?? '';

	assert.equal(rawContent.includes('sk-ant-abcdef1234567890'), false);
	assert.equal(rawContent.includes('[REDACTED'), true);
});

test('a rate-limit-shaped assistant record is flagged structurally', async () => {
	const lines = [
		line({
			type: 'assistant',
			message: {
				id: 'msg_ratelimit',
				model: '<synthetic>',
				role: 'assistant',
				content: [{ type: 'text', text: "You've hit your session limit · resets 11:40pm" }],
				usage: { input_tokens: 0, output_tokens: 0 },
			},
			uuid: 'u1',
			timestamp: 't1',
			error: 'rate_limit',
			isApiErrorMessage: true,
			apiErrorStatus: 429,
		}),
	];

	const session = await parseRecords(lines, context);
	const turn = session.timeline.find((e): e is AssistantTurnEvent => e.kind === 'assistant-turn');

	assert.equal(turn?.rateLimited, true);
	assert.equal(turn?.apiErrorStatus, 429);
});

test('an ordinary assistant record is never flagged as rate-limited', async () => {
	const lines = [
		line({
			type: 'assistant',
			message: {
				id: 'msg_ordinary',
				model: 'claude-sonnet-5',
				role: 'assistant',
				content: [{ type: 'text', text: 'hello' }],
				usage: { input_tokens: 5, output_tokens: 5 },
			},
			uuid: 'u1',
			timestamp: 't1',
		}),
	];

	const session = await parseRecords(lines, context);
	const turn = session.timeline.find((e): e is AssistantTurnEvent => e.kind === 'assistant-turn');

	assert.equal(turn?.rateLimited, false);
	assert.equal(turn?.apiErrorStatus, undefined);
});

test('secrets in a tool_use input are scrubbed before being surfaced', async () => {
	const lines = [
		line({
			type: 'assistant',
			message: {
				id: 'msg_secret',
				model: 'claude-sonnet-5',
				role: 'assistant',
				content: [
					{
						type: 'tool_use',
						id: 'toolu_secret',
						name: 'Bash',
						input: { command: 'echo ANTHROPIC_API_KEY=sk-ant-api03-realkeyvalue1234' },
					},
				],
				usage: { input_tokens: 1, output_tokens: 1 },
			},
			uuid: 'u1',
			timestamp: 't1',
		}),
	];

	const session = await parseRecords(lines, context);
	const call = session.timeline.find((e): e is ToolCallEvent => e.kind === 'tool-call');
	const input = call?.input as { command: string } | undefined;

	assert.ok(input?.command.includes('[REDACTED'));
	assert.ok(!input?.command.includes('realkeyvalue1234'));
});
