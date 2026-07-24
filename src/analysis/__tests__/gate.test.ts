import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
	AssistantTurnEvent,
	AttachmentBucket,
	ParsedSession,
	TimelineEvent,
	ToolCallEvent,
	UserMessageEvent,
} from '../../parser/index.js';
import type { LintFinding } from '../../lint/index.js';
import type { SessionStats } from '../../stats/index.js';
import { checkBoundaryFollowedByCompact } from '../../lint/boundary-compact.js';
import { collectGateTriggers } from '../gate.js';

function emptyAttachments(): AttachmentBucket {
	return {
		hookSuccess: [],
		skillListing: [],
		deferredToolsDelta: [],
		agentListingDelta: [],
		mcpInstructionsDelta: [],
		outputStyle: [],
		unknown: [],
	};
}

function makeSession(timeline: TimelineEvent[]): ParsedSession {
	return {
		sessionId: 'session-1',
		projectSlug: 'second-flow',
		filePath: '/fake/path.jsonl',
		timeline,
		attachments: emptyAttachments(),
		noise: { count: 0, byType: {} },
		meta: { aiTitles: [] },
	};
}

function emptyStats(overrides: Partial<SessionStats> = {}): SessionStats {
	return {
		sessionId: 'session-1',
		projectSlug: 'second-flow',
		agents: { invocations: [], byType: [] },
		contextBudget: [],
		cache: { series: [], unexplainedDrops: [] },
		rateLimitHits: [],
		boundaryCandidates: [],
		...overrides,
	};
}

function makeToolCall(toolUseId: string, isSubagentSpawn = false): ToolCallEvent {
	return {
		kind: 'tool-call',
		toolUseId,
		toolName: isSubagentSpawn ? 'Agent' : 'Bash',
		input: isSubagentSpawn ? {} : { command: 'echo hi' },
		callerUuid: 'turn-1',
		callTimestamp: 't',
		isSubagentSpawn,
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

function makeUserMessage(text: string): UserMessageEvent {
	return { kind: 'user-message', text };
}

test('a clean session with no signals produces zero triggers', () => {
	const session = makeSession([makeUserMessage('Please add a login button.')]);

	assert.deepEqual(collectGateTriggers(session, emptyStats(), []), []);
});

test('a lint finding resolves to its tool-call raw timeline index', () => {
	const timeline = [makeUserMessage('hello'), makeToolCall('call-a')];
	const session = makeSession(timeline);
	const lintFindings: LintFinding[] = [
		{
			checkerId: 'commit-gating',
			toolUseId: 'call-a',
			timestamp: 't',
			evidence: 'no approval',
		},
	];

	const triggers = collectGateTriggers(session, emptyStats(), lintFindings);

	assert.equal(triggers.length, 1);
	assert.equal(triggers[0].kind, 'lint-finding');
	assert.equal(triggers[0].timelineIndex, 1);
});

test('a boundary-compact finding flows through as an ordinary lint-finding trigger, no special-casing', () => {
	const timeline: TimelineEvent[] = [
		{
			kind: 'tool-call',
			toolUseId: 'call-a',
			toolName: 'Bash',
			input: { command: 'git commit -m "x"' },
			callerUuid: 'turn-1',
			callTimestamp: 't1',
			isSubagentSpawn: false,
			isBackground: false,
			result: { kind: 'sync', text: 'ok' },
		},
	];
	const session = makeSession(timeline);
	const lintFindings = checkBoundaryFollowedByCompact(timeline);

	const triggers = collectGateTriggers(session, emptyStats(), lintFindings);

	assert.equal(triggers.length, 1);
	assert.equal(triggers[0].kind, 'lint-finding');
	assert.equal(triggers[0].timelineIndex, 0);
});

test('a rate-limit hit resolves via the assistant-turn index, not the raw timeline index', () => {
	const timeline = [makeToolCall('call-a'), makeAssistantTurn('turn-1')];
	const session = makeSession(timeline);
	const stats = emptyStats({
		rateLimitHits: [
			{ turnIndex: 0, messageId: 'm-turn-1', timestamp: 't', apiErrorStatus: 429 },
		],
	});

	const triggers = collectGateTriggers(session, stats, []);

	assert.equal(triggers.length, 1);
	assert.equal(triggers[0].kind, 'rate-limit-hit');
	assert.equal(
		triggers[0].timelineIndex,
		1,
		'must resolve to the raw index of the 0th assistant-turn',
	);
});

test('an unexplained cache drop resolves via toTurnIndex', () => {
	const timeline = [makeAssistantTurn('turn-1'), makeAssistantTurn('turn-2')];
	const session = makeSession(timeline);
	const stats = emptyStats({
		cache: {
			series: [],
			unexplainedDrops: [
				{ fromTurnIndex: 0, toTurnIndex: 1, fromRatio: 0.9, toRatio: 0.5, drop: 0.4 },
			],
		},
	});

	const triggers = collectGateTriggers(session, stats, []);

	assert.equal(triggers.length, 1);
	assert.equal(triggers[0].kind, 'unexplained-cache-drop');
	assert.equal(triggers[0].timelineIndex, 1);
});

test('a repeat-candidate subagent group produces one trigger per invocation', () => {
	const timeline = [makeToolCall('call-a', true), makeToolCall('call-b', true)];
	const session = makeSession(timeline);
	const stats = emptyStats({
		agents: {
			invocations: [],
			byType: [
				{
					subagentType: 'Explore',
					invocationCount: 2,
					isRepeatCandidate: true,
					invocations: [
						{ toolUseId: 'call-a', callTimestamp: 't1' },
						{ toolUseId: 'call-b', callTimestamp: 't2' },
					],
				},
			],
		},
	});

	const triggers = collectGateTriggers(session, stats, []);

	assert.equal(triggers.length, 2);
	assert.ok(triggers.every((trigger) => trigger.kind === 'repeat-subagent-invocation'));
});

test('a non-repeat-candidate subagent group produces no triggers', () => {
	const timeline = [makeToolCall('call-a', true)];
	const session = makeSession(timeline);
	const stats = emptyStats({
		agents: {
			invocations: [],
			byType: [
				{
					subagentType: 'Explore',
					invocationCount: 1,
					isRepeatCandidate: false,
					invocations: [{ toolUseId: 'call-a', callTimestamp: 't1' }],
				},
			],
		},
	});

	assert.deepEqual(collectGateTriggers(session, stats, []), []);
});

test('a user pushback message produces a user-pushback trigger at its raw loop position', () => {
	const timeline = [makeUserMessage('hi'), makeUserMessage("No, that's wrong, revert that.")];
	const session = makeSession(timeline);

	const triggers = collectGateTriggers(session, emptyStats(), []);

	assert.equal(triggers.length, 1);
	assert.equal(triggers[0].kind, 'user-pushback');
	assert.equal(triggers[0].timelineIndex, 1);
});

test('a user clarifying question produces a user-clarifying-question trigger', () => {
	const timeline = [makeUserMessage('What do you mean by that?')];
	const session = makeSession(timeline);

	const triggers = collectGateTriggers(session, emptyStats(), []);

	assert.equal(triggers.length, 1);
	assert.equal(triggers[0].kind, 'user-clarifying-question');
	assert.equal(triggers[0].timelineIndex, 0);
});
