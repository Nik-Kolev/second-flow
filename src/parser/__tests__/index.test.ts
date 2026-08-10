import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { parseSession, parseSessionFile } from '../index.js';
import type { ToolCallEvent } from '../types.js';

let tempRoot: string;

before(async () => {
	tempRoot = await mkdtemp(path.join(os.tmpdir(), 'second-flow-index-test-'));
	process.env.CLAUDE_PROJECTS_DIR = tempRoot;
	const slugDir = path.join(tempRoot, 'demo-slug');
	await mkdir(slugDir, { recursive: true });
	const record = JSON.stringify({
		type: 'user',
		message: { role: 'user', content: 'hi' },
		uuid: 'u1',
		timestamp: 't1',
	});
	await writeFile(path.join(slugDir, 'session-x.jsonl'), `${record}\n`);
});

test('parseSessionFile derives sessionId/projectSlug from the file path and reads the file', async () => {
	const filePath = path.join(tempRoot, 'demo-slug', 'session-x.jsonl');
	const session = await parseSessionFile(filePath);

	assert.equal(session.sessionId, 'session-x');
	assert.equal(session.projectSlug, 'demo-slug');
	assert.equal(session.timeline.length, 1);
});

test('parseSession resolves the latest file for a slug end-to-end', async () => {
	const session = await parseSession('demo-slug');
	assert.equal(session.sessionId, 'session-x');
});

test('parseSession throws a clear error when no session files exist for a slug', async () => {
	await mkdir(path.join(tempRoot, 'empty-slug'), { recursive: true });
	await assert.rejects(() => parseSession('empty-slug'), /No session files found/);
});

test('parseSessionFile wires a subagent spawn to its real model end-to-end', async () => {
	const sessionId = 'session-with-agent';
	const slugDir = path.join(tempRoot, 'demo-slug');
	const filePath = path.join(slugDir, `${sessionId}.jsonl`);

	const spawnRecord = JSON.stringify({
		type: 'assistant',
		message: {
			id: 'msg_spawn',
			model: 'claude-sonnet-5',
			role: 'assistant',
			content: [
				{
					type: 'tool_use',
					id: 'toolu_e2e',
					name: 'Agent',
					input: { subagent_type: 'Explore' },
				},
			],
			usage: { input_tokens: 1, output_tokens: 1 },
		},
		uuid: 'u1',
		timestamp: 't1',
	});
	const resultRecord = JSON.stringify({
		type: 'user',
		message: {
			role: 'user',
			content: [
				{
					type: 'tool_result',
					tool_use_id: 'toolu_e2e',
					content: [{ type: 'text', text: 'done' }],
				},
			],
		},
		uuid: 'u2',
		timestamp: 't2',
	});
	await writeFile(filePath, `${spawnRecord}\n${resultRecord}\n`);

	const subagentsDir = path.join(slugDir, sessionId, 'subagents');
	await mkdir(subagentsDir, { recursive: true });
	await writeFile(
		path.join(subagentsDir, 'agent-e2e.meta.json'),
		JSON.stringify({ toolUseId: 'toolu_e2e', agentType: 'Explore' }),
	);
	await writeFile(
		path.join(subagentsDir, 'agent-e2e.jsonl'),
		`${JSON.stringify({
			type: 'assistant',
			message: {
				id: 'sub_msg_1',
				model: 'claude-haiku-4-5',
				role: 'assistant',
				content: [{ type: 'text', text: 'exploring' }],
				usage: { input_tokens: 1, output_tokens: 1 },
			},
			uuid: 'su1',
			timestamp: 'st1',
		})}\n`,
	);

	const session = await parseSessionFile(filePath);
	const call = session.timeline.find((e): e is ToolCallEvent => e.kind === 'tool-call');

	assert.equal(call?.isSubagentSpawn, true);
	assert.equal(call?.subagentModel, 'claude-haiku-4-5');
});
