import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { enrichSubagentModels } from '../subagent-model.js';
import type { ToolCallEvent } from '../types.js';

function makeSpawnCall(toolUseId: string): ToolCallEvent {
	return {
		kind: 'tool-call',
		toolUseId,
		toolName: 'Agent',
		input: { subagent_type: 'Explore' },
		callerUuid: 'u1',
		callTimestamp: 't1',
		isSubagentSpawn: true,
		isBackground: false,
		result: { kind: 'pending' },
	};
}

function assistantLine(model: string): string {
	return JSON.stringify({
		type: 'assistant',
		message: {
			id: 'sub_msg_1',
			model,
			role: 'assistant',
			content: [{ type: 'text', text: 'ok' }],
			usage: { input_tokens: 1, output_tokens: 1 },
		},
		uuid: 'su1',
		timestamp: 'st1',
	});
}

async function setup(): Promise<{
	tempRoot: string;
	filePath: string;
	sessionId: string;
	subagentsDir: string;
}> {
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'second-flow-subagent-model-test-'));
	const sessionId = 'sess1';
	const filePath = path.join(tempRoot, `${sessionId}.jsonl`);
	const subagentsDir = path.join(tempRoot, sessionId, 'subagents');
	return { tempRoot, filePath, sessionId, subagentsDir };
}

test('a matching sidecar + subagent file resolves subagentModel', async () => {
	const { filePath, sessionId, subagentsDir } = await setup();
	await mkdir(subagentsDir, { recursive: true });
	await writeFile(
		path.join(subagentsDir, 'agent-abc.meta.json'),
		JSON.stringify({ toolUseId: 'toolu_1', agentType: 'Explore' }),
	);
	await writeFile(
		path.join(subagentsDir, 'agent-abc.jsonl'),
		`${assistantLine('claude-haiku-4-5')}\n`,
	);

	const timeline = [makeSpawnCall('toolu_1')];
	await enrichSubagentModels(timeline, filePath, sessionId);

	assert.equal(timeline[0].subagentModel, 'claude-haiku-4-5');
});

test('no subagents directory at all does not throw and leaves subagentModel unset', async () => {
	const { filePath, sessionId } = await setup();

	const timeline = [makeSpawnCall('toolu_1')];
	await assert.doesNotReject(() => enrichSubagentModels(timeline, filePath, sessionId));

	assert.equal(timeline[0].subagentModel, undefined);
});

test('a sidecar with no matching toolUseId leaves subagentModel unset', async () => {
	const { filePath, sessionId, subagentsDir } = await setup();
	await mkdir(subagentsDir, { recursive: true });
	await writeFile(
		path.join(subagentsDir, 'agent-abc.meta.json'),
		JSON.stringify({ toolUseId: 'toolu_other' }),
	);
	await writeFile(
		path.join(subagentsDir, 'agent-abc.jsonl'),
		`${assistantLine('claude-haiku-4-5')}\n`,
	);

	const timeline = [makeSpawnCall('toolu_1')];
	await enrichSubagentModels(timeline, filePath, sessionId);

	assert.equal(timeline[0].subagentModel, undefined);
});

test('a malformed sidecar is skipped without breaking a sibling valid sidecar', async () => {
	const { filePath, sessionId, subagentsDir } = await setup();
	await mkdir(subagentsDir, { recursive: true });
	await writeFile(path.join(subagentsDir, 'agent-bad.meta.json'), '{not valid json');
	await writeFile(
		path.join(subagentsDir, 'agent-good.meta.json'),
		JSON.stringify({ toolUseId: 'toolu_1' }),
	);
	await writeFile(
		path.join(subagentsDir, 'agent-good.jsonl'),
		`${assistantLine('claude-sonnet-5')}\n`,
	);

	const timeline = [makeSpawnCall('toolu_1')];
	await enrichSubagentModels(timeline, filePath, sessionId);

	assert.equal(timeline[0].subagentModel, 'claude-sonnet-5');
});

test('a sidecar matching a missing .jsonl file leaves subagentModel unset', async () => {
	const { filePath, sessionId, subagentsDir } = await setup();
	await mkdir(subagentsDir, { recursive: true });
	await writeFile(
		path.join(subagentsDir, 'agent-abc.meta.json'),
		JSON.stringify({ toolUseId: 'toolu_1' }),
	);

	const timeline = [makeSpawnCall('toolu_1')];
	await assert.doesNotReject(() => enrichSubagentModels(timeline, filePath, sessionId));

	assert.equal(timeline[0].subagentModel, undefined);
});

test('garbage after the first assistant record does not prevent resolution', async () => {
	const { filePath, sessionId, subagentsDir } = await setup();
	await mkdir(subagentsDir, { recursive: true });
	await writeFile(
		path.join(subagentsDir, 'agent-abc.meta.json'),
		JSON.stringify({ toolUseId: 'toolu_1' }),
	);
	await writeFile(
		path.join(subagentsDir, 'agent-abc.jsonl'),
		`${assistantLine('claude-sonnet-5')}\nnot valid json at all\n`,
	);

	const timeline = [makeSpawnCall('toolu_1')];
	await enrichSubagentModels(timeline, filePath, sessionId);

	assert.equal(timeline[0].subagentModel, 'claude-sonnet-5');
});
