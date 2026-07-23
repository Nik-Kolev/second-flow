import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resolveGlobalClaudeMdPath, resolveProjectClaudeMdPath } from '../locate.js';

test('resolveGlobalClaudeMdPath defaults to os.homedir()', () => {
	assert.equal(resolveGlobalClaudeMdPath(), path.join(os.homedir(), '.claude', 'CLAUDE.md'));
});

test('resolveGlobalClaudeMdPath honors the homeDir override', () => {
	assert.equal(
		resolveGlobalClaudeMdPath({ homeDir: '/tmp/fake-home' }),
		path.join('/tmp/fake-home', '.claude', 'CLAUDE.md'),
	);
});

test('resolveProjectClaudeMdPath joins cwd with CLAUDE.md', () => {
	assert.equal(
		resolveProjectClaudeMdPath('/repo/second-flow'),
		path.join('/repo/second-flow', 'CLAUDE.md'),
	);
});
