import os from 'node:os';
import path from 'node:path';
import type { RulebookDiscoveryOptions } from './types.js';

export function resolveGlobalClaudeMdPath(opts?: RulebookDiscoveryOptions): string {
	return path.join(opts?.homeDir ?? os.homedir(), '.claude', 'CLAUDE.md');
}

export function resolveProjectClaudeMdPath(cwd: string): string {
	return path.join(cwd, 'CLAUDE.md');
}
