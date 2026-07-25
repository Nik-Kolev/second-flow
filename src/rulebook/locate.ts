import os from 'node:os';
import path from 'node:path';
import { slugFromCwd } from '../parser/index.js';
import type { RulebookDiscoveryOptions } from './types.js';

export function resolveGlobalClaudeMdPath(opts?: RulebookDiscoveryOptions): string {
	return path.join(opts?.homeDir ?? os.homedir(), '.claude', 'CLAUDE.md');
}

export function resolveProjectClaudeMdPath(cwd: string): string {
	return path.join(cwd, 'CLAUDE.md');
}

export function resolveGlobalMemoryDir(opts?: RulebookDiscoveryOptions): string {
	return path.join(opts?.homeDir ?? os.homedir(), '.claude', 'memory');
}

export function resolveStackDir(opts?: RulebookDiscoveryOptions): string {
	return path.join(opts?.homeDir ?? os.homedir(), '.claude', 'rules');
}

export function resolveProjectMemoryDir(cwd: string, opts?: RulebookDiscoveryOptions): string {
	return path.join(
		opts?.homeDir ?? os.homedir(),
		'.claude',
		'projects',
		slugFromCwd(cwd),
		'memory',
	);
}
