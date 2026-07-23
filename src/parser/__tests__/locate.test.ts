import assert from 'node:assert/strict';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import {
	findLatestSessionFile,
	listSessionFiles,
	resolveProjectsRoot,
	resolveSessionFilePath,
	slugFromCwd,
} from '../locate.js';

let tempRoot: string;
const originalEnv = process.env.CLAUDE_PROJECTS_DIR;

before(async () => {
	tempRoot = await mkdtemp(path.join(os.tmpdir(), 'second-flow-locate-test-'));
	process.env.CLAUDE_PROJECTS_DIR = tempRoot;

	const slugDir = path.join(tempRoot, 'my-slug');
	await mkdir(slugDir, { recursive: true });
	await writeFile(path.join(slugDir, 'session-a.jsonl'), '{}');
	await writeFile(path.join(slugDir, 'session-b.jsonl'), '{}');
	await writeFile(path.join(slugDir, 'CLAUDE.md'), '# not a session');

	// A subagent's own directory sitting right alongside the session files — must never surface.
	const subagentsDir = path.join(slugDir, 'session-a', 'subagents');
	await mkdir(subagentsDir, { recursive: true });
	await writeFile(path.join(subagentsDir, 'agent-123.jsonl'), '{}');

	const now = new Date();
	await utimes(path.join(slugDir, 'session-a.jsonl'), now, new Date(now.getTime() - 60_000));
	await utimes(path.join(slugDir, 'session-b.jsonl'), now, now);
});

after(() => {
	process.env.CLAUDE_PROJECTS_DIR = originalEnv;
});

test('resolveProjectsRoot honors the env var override', () => {
	assert.equal(resolveProjectsRoot(), tempRoot);
});

test('listSessionFiles only returns .jsonl files directly in the slug directory, never the subagents/ subdirectory', async () => {
	const files = await listSessionFiles('my-slug');
	const names = files.map((f) => path.basename(f)).sort();

	assert.deepEqual(names, ['session-a.jsonl', 'session-b.jsonl']);
});

test('findLatestSessionFile picks the most recently modified file', async () => {
	const latest = await findLatestSessionFile('my-slug');
	assert.equal(path.basename(latest ?? ''), 'session-b.jsonl');
});

test('resolveSessionFilePath builds the expected path without touching the filesystem', () => {
	const result = resolveSessionFilePath('my-slug', 'session-a');
	assert.equal(result, path.join(tempRoot, 'my-slug', 'session-a.jsonl'));
});

test('listSessionFiles throws a clear error for a missing slug directory', async () => {
	await assert.rejects(
		() => listSessionFiles('does-not-exist'),
		/No Claude Code project directory found/,
	);
});

test('slugFromCwd replaces path separators and colons with dashes', () => {
	assert.equal(
		slugFromCwd('C:\\Users\\user\\Documents\\GitHub\\second-flow'),
		'C--Users-user-Documents-GitHub-second-flow',
	);
});
