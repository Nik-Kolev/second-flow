import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { slugFromCwd } from '../../parser/index.js';
import type { ToolCallEvent } from '../../parser/types.js';
import { discoverMemoryRulebook, extractReadPaths } from '../memory.js';

function readCall(filePath: unknown, toolUseId = 'toolu_1'): ToolCallEvent {
	return {
		kind: 'tool-call',
		toolUseId,
		toolName: 'Read',
		input: { file_path: filePath },
		callerUuid: 'assistant-1',
		callTimestamp: '2026-07-26T00:00:00.000Z',
		isSubagentSpawn: false,
		isBackground: false,
		result: { kind: 'sync', text: 'irrelevant — content always comes from a live disk read' },
	};
}

async function makeFixture() {
	const homeDir = await mkdtemp(path.join(os.tmpdir(), 'second-flow-rulebook-memory-test-'));
	const cwd = await mkdtemp(path.join(os.tmpdir(), 'second-flow-rulebook-memory-cwd-test-'));
	const globalMemoryDir = path.join(homeDir, '.claude', 'memory');
	const stackDir = path.join(homeDir, '.claude', 'rules');
	const projectMemoryDir = path.join(homeDir, '.claude', 'projects', slugFromCwd(cwd), 'memory');
	await mkdir(globalMemoryDir, { recursive: true });
	await mkdir(stackDir, { recursive: true });
	await mkdir(projectMemoryDir, { recursive: true });
	return { homeDir, cwd, globalMemoryDir, stackDir, projectMemoryDir };
}

test('classifies a Read of a global memory file', async () => {
	const { homeDir, cwd, globalMemoryDir } = await makeFixture();
	const filePath = path.join(globalMemoryDir, 'gotcha.md');
	await writeFile(filePath, 'a documented gotcha');

	const paths = extractReadPaths([readCall(filePath)], cwd, { homeDir });
	assert.deepEqual([...paths.globalMemory], [path.normalize(filePath)]);
	assert.equal(paths.projectMemory.size, 0);
	assert.equal(paths.stack.size, 0);

	const result = await discoverMemoryRulebook([readCall(filePath)], cwd, { homeDir });
	assert.equal(result.count, 1);
	assert.deepEqual(result.blocks, [
		{
			origin: 'memory',
			layer: 'memory',
			sourceKind: 'global-memory',
			source: filePath,
			text: 'a documented gotcha',
		},
	]);
});

test('classifies a Read of a project memory file', async () => {
	const { homeDir, cwd, projectMemoryDir } = await makeFixture();
	const filePath = path.join(projectMemoryDir, 'current-state.md');
	await writeFile(filePath, 'project-specific state');

	const paths = extractReadPaths([readCall(filePath)], cwd, { homeDir });
	assert.deepEqual([...paths.projectMemory], [path.normalize(filePath)]);

	const result = await discoverMemoryRulebook([readCall(filePath)], cwd, { homeDir });
	assert.equal(result.blocks[0]?.sourceKind, 'project-memory');
});

test('classifies a Read of a stack file', async () => {
	const { homeDir, cwd, stackDir } = await makeFixture();
	const filePath = path.join(stackDir, 'prisma.md');
	await writeFile(filePath, 'prisma conventions');

	const paths = extractReadPaths([readCall(filePath)], cwd, { homeDir });
	assert.deepEqual([...paths.stack], [path.normalize(filePath)]);

	const result = await discoverMemoryRulebook([readCall(filePath)], cwd, { homeDir });
	assert.equal(result.blocks[0]?.sourceKind, 'stack');
});

test('a Read outside all three directories is ignored', async () => {
	const { homeDir, cwd } = await makeFixture();
	const unrelated = path.join(cwd, 'src', 'index.ts');

	const paths = extractReadPaths([readCall(unrelated)], cwd, { homeDir });
	assert.equal(paths.globalMemory.size, 0);
	assert.equal(paths.projectMemory.size, 0);
	assert.equal(paths.stack.size, 0);
});

test('a non-Read tool call is ignored even if input has a matching file_path', async () => {
	const { homeDir, cwd, globalMemoryDir } = await makeFixture();
	const filePath = path.join(globalMemoryDir, 'gotcha.md');
	await writeFile(filePath, 'a documented gotcha');

	const grepCall: ToolCallEvent = { ...readCall(filePath), toolName: 'Grep' };
	const paths = extractReadPaths([grepCall], cwd, { homeDir });
	assert.equal(paths.globalMemory.size, 0);
});

test('a relative file_path is ignored, never matched', async () => {
	const { homeDir, cwd } = await makeFixture();

	const paths = extractReadPaths([readCall('memory/gotcha.md')], cwd, { homeDir });
	assert.equal(paths.globalMemory.size, 0);
});

test('a non-string file_path is ignored', async () => {
	const { homeDir, cwd } = await makeFixture();

	const paths = extractReadPaths([readCall(42)], cwd, { homeDir });
	assert.equal(paths.globalMemory.size, 0);
});

test('a matched file missing on disk at discovery time is skipped, not errored', async () => {
	const { homeDir, cwd, globalMemoryDir } = await makeFixture();
	const neverWritten = path.join(globalMemoryDir, 'deleted-since.md');

	const result = await discoverMemoryRulebook([readCall(neverWritten)], cwd, { homeDir });
	assert.deepEqual(result.blocks, []);
	assert.equal(result.count, 0);
});

test('the same path Read twice dedupes to a single block', async () => {
	const { homeDir, cwd, globalMemoryDir } = await makeFixture();
	const filePath = path.join(globalMemoryDir, 'gotcha.md');
	await writeFile(filePath, 'a documented gotcha');

	const result = await discoverMemoryRulebook(
		[readCall(filePath, 'toolu_1'), readCall(filePath, 'toolu_2')],
		cwd,
		{ homeDir },
	);
	assert.equal(result.count, 1);
});
