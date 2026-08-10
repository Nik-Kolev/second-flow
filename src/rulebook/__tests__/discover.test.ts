import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { discoverGlobalRulebook, discoverProjectRulebook } from '../discover.js';

test('discoverGlobalRulebook returns a user-layer block when the file has content', async () => {
	const homeDir = await mkdtemp(path.join(os.tmpdir(), 'second-flow-rulebook-discover-test-'));
	await mkdir(path.join(homeDir, '.claude'), { recursive: true });
	const filePath = path.join(homeDir, '.claude', 'CLAUDE.md');
	await writeFile(filePath, '# Global rules\nAlways do X.');

	const result = await discoverGlobalRulebook({ homeDir });

	assert.equal(result.found, true);
	assert.equal(result.blocks.length, 1);
	assert.equal(result.blocks[0].origin, 'file');
	assert.equal(result.blocks[0].layer, 'user');
	assert.equal(result.blocks[0].source, filePath);
	assert.equal(result.blocks[0].text, '# Global rules\nAlways do X.');
});

test('discoverGlobalRulebook returns found: false when no .claude directory exists', async () => {
	const homeDir = await mkdtemp(path.join(os.tmpdir(), 'second-flow-rulebook-discover-test-'));
	const result = await discoverGlobalRulebook({ homeDir });
	assert.deepEqual(result, { blocks: [], found: false });
});

test('discoverGlobalRulebook returns found: true but no blocks for a whitespace-only file', async () => {
	const homeDir = await mkdtemp(path.join(os.tmpdir(), 'second-flow-rulebook-discover-test-'));
	await mkdir(path.join(homeDir, '.claude'), { recursive: true });
	await writeFile(path.join(homeDir, '.claude', 'CLAUDE.md'), '   \n\t  ');

	const result = await discoverGlobalRulebook({ homeDir });

	// The file genuinely exists and was read — that must stay distinguishable from "missing".
	assert.equal(result.found, true);
	assert.deepEqual(result.blocks, []);
});

test('discoverProjectRulebook returns a project-layer block when the file has content', async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), 'second-flow-rulebook-project-test-'));
	const filePath = path.join(cwd, 'CLAUDE.md');
	await writeFile(filePath, '# Project rules\nUse tabs.');

	const result = await discoverProjectRulebook(cwd);

	assert.equal(result.found, true);
	assert.equal(result.blocks.length, 1);
	assert.equal(result.blocks[0].origin, 'file');
	assert.equal(result.blocks[0].layer, 'project');
	assert.equal(result.blocks[0].source, filePath);
});

test('discoverProjectRulebook returns found: false when the project has no CLAUDE.md', async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), 'second-flow-rulebook-project-test-'));
	const result = await discoverProjectRulebook(cwd);
	assert.deepEqual(result, { blocks: [], found: false });
});

test('discoverProjectRulebook returns found: false for a non-absolute cwd without touching the filesystem', async () => {
	const result = await discoverProjectRulebook('relative/path');
	assert.deepEqual(result, { blocks: [], found: false });
});
