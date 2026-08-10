import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ToolCallEvent } from '../../parser/types.js';
import {
	resolveGlobalClaudeMdPath,
	resolveProjectClaudeMdPath,
	resolveRulebook,
} from '../index.js';
import type { AttachmentBucket } from '../types.js';

function emptyBucket(overrides: Partial<AttachmentBucket> = {}): AttachmentBucket {
	return {
		hookSuccess: [],
		skillListing: [],
		deferredToolsDelta: [],
		agentListingDelta: [],
		mcpInstructionsDelta: [],
		outputStyle: [],
		unknown: [],
		...overrides,
	};
}

function readCall(filePath: string): ToolCallEvent {
	return {
		kind: 'tool-call',
		toolUseId: 'toolu_read',
		toolName: 'Read',
		input: { file_path: filePath },
		callerUuid: 'assistant-1',
		callTimestamp: '2026-07-26T00:00:00.000Z',
		isSubagentSpawn: false,
		isBackground: false,
		result: { kind: 'sync', text: 'irrelevant — memory.ts re-reads from disk' },
	};
}

test('combines all five sources with correct diagnostics', async () => {
	const homeDir = await mkdtemp(path.join(os.tmpdir(), 'second-flow-rulebook-index-test-'));
	await mkdir(path.join(homeDir, '.claude'), { recursive: true });
	await writeFile(path.join(homeDir, '.claude', 'CLAUDE.md'), 'global rule text');

	const cwd = await mkdtemp(path.join(os.tmpdir(), 'second-flow-rulebook-index-cwd-test-'));
	await writeFile(path.join(cwd, 'CLAUDE.md'), 'project rule text');

	const attachments = emptyBucket({
		hookSuccess: [{ hookEvent: 'SessionStart', content: 'hook rule text' }],
		outputStyle: [{ style: 'Explanatory' }],
	});

	const resolution = await resolveRulebook(attachments, { cwd }, [], { homeDir });

	assert.equal(resolution.blocks.length, 4);
	assert.deepEqual(
		resolution.blocks.map((b) => b.origin),
		['file', 'file', 'hook', 'transcript'],
	);
	assert.deepEqual(resolution.sources.global, {
		path: resolveGlobalClaudeMdPath({ homeDir }),
		found: true,
	});
	assert.deepEqual(resolution.sources.project, {
		path: resolveProjectClaudeMdPath(cwd),
		found: true,
	});
	assert.equal(resolution.sources.hook.count, 1);
	assert.equal(resolution.sources.environmental.count, 1);
	assert.equal(resolution.sources.memory.count, 0);
});

test('a Read of a global memory file adds a memory block, appended last', async () => {
	const homeDir = await mkdtemp(path.join(os.tmpdir(), 'second-flow-rulebook-index-test-'));
	await mkdir(path.join(homeDir, '.claude', 'memory'), { recursive: true });
	const memoryFile = path.join(homeDir, '.claude', 'memory', 'gotcha.md');
	await writeFile(memoryFile, 'a documented gotcha');

	const cwd = await mkdtemp(path.join(os.tmpdir(), 'second-flow-rulebook-index-cwd-test-'));

	const resolution = await resolveRulebook(emptyBucket(), { cwd }, [readCall(memoryFile)], {
		homeDir,
	});

	assert.equal(resolution.sources.memory.count, 1);
	assert.equal(resolution.blocks.at(-1)?.origin, 'memory');
	assert.equal(resolution.blocks.at(-1)?.text, 'a documented gotcha');
});

test('no project block, null project path, and no memory discovery when meta.cwd is undefined', async () => {
	const homeDir = await mkdtemp(path.join(os.tmpdir(), 'second-flow-rulebook-index-test-'));

	const resolution = await resolveRulebook(emptyBucket(), {}, [], { homeDir });

	assert.equal(resolution.sources.project.path, null);
	assert.equal(resolution.sources.project.found, false);
	assert.equal(
		resolution.blocks.some((b) => b.layer === 'project'),
		false,
	);
	assert.equal(resolution.sources.memory.count, 0);
});

test('empty resolution when nothing is present anywhere', async () => {
	const homeDir = await mkdtemp(path.join(os.tmpdir(), 'second-flow-rulebook-index-test-'));

	const resolution = await resolveRulebook(emptyBucket(), {}, [], { homeDir });

	assert.deepEqual(resolution.blocks, []);
	assert.equal(resolution.sources.global.found, false);
	assert.equal(resolution.sources.hook.count, 0);
	assert.equal(resolution.sources.environmental.count, 0);
	assert.equal(resolution.sources.memory.count, 0);
});
