import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { parseSession, parseSessionFile } from '../index.js';

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
