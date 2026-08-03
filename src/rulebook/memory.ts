import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TimelineEvent } from '../parser/index.js';
import { scrubText } from '../parser/index.js';
import { resolveGlobalMemoryDir, resolveProjectMemoryDir, resolveStackDir } from './locate.js';
import type { MemoryRuleBlock, RulebookDiscoveryOptions } from './types.js';

// Mirrors extractShellCommand's guard — the typeof/null check must come before the cast, not after.
function extractFilePath(input: unknown): string | undefined {
	if (typeof input !== 'object' || input === null) {
		return undefined;
	}
	const value = (input as { file_path?: unknown }).file_path;
	return typeof value === 'string' ? value : undefined;
}

export interface ReadPaths {
	globalMemory: Set<string>;
	projectMemory: Set<string>;
	stack: Set<string>;
}

// Windows paths are case-insensitive, but a transcript's recorded casing can differ from os.homedir()'s — fold both sides before comparing, or a real read gets missed.
const foldPathForComparison =
	os.platform() === 'win32' ? (p: string) => p.toLowerCase() : (p: string) => p;

// Read-only, not Grep/Glob — only a Read puts content into context. Relative file_path is skipped since Claude Code's Read tool always uses absolute paths.
export function extractReadPaths(
	timeline: TimelineEvent[],
	cwd: string,
	opts?: RulebookDiscoveryOptions,
): ReadPaths {
	const dirs = {
		globalMemory: path.normalize(resolveGlobalMemoryDir(opts)),
		projectMemory: path.normalize(resolveProjectMemoryDir(cwd, opts)),
		stack: path.normalize(resolveStackDir(opts)),
	};
	const paths: ReadPaths = {
		globalMemory: new Set(),
		projectMemory: new Set(),
		stack: new Set(),
	};

	for (const event of timeline) {
		if (event.kind !== 'tool-call' || event.toolName !== 'Read') {
			continue;
		}
		const filePath = extractFilePath(event.input);
		if (!filePath || !path.isAbsolute(filePath)) {
			continue;
		}
		const normalized = path.normalize(filePath);
		const folded = foldPathForComparison(normalized);
		if (folded.startsWith(foldPathForComparison(dirs.globalMemory) + path.sep)) {
			paths.globalMemory.add(normalized);
		} else if (folded.startsWith(foldPathForComparison(dirs.projectMemory) + path.sep)) {
			paths.projectMemory.add(normalized);
		} else if (folded.startsWith(foldPathForComparison(dirs.stack) + path.sep)) {
			paths.stack.add(normalized);
		}
	}

	return paths;
}

async function readMemoryBlock(
	filePath: string,
	sourceKind: MemoryRuleBlock['sourceKind'],
): Promise<MemoryRuleBlock | null> {
	let raw: string;
	try {
		raw = await fs.readFile(filePath, 'utf-8');
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ENOTDIR') {
			return null;
		}
		throw error;
	}
	const text = scrubText(raw.trim());
	if (!text) {
		return null;
	}
	return { origin: 'memory', layer: 'memory', sourceKind, source: filePath, text };
}

export interface MemoryDiscoveryResult {
	blocks: MemoryRuleBlock[];
	count: number;
}

// Scope comes from the transcript; content is always re-read live from disk, same as CLAUDE.md, never frozen to what the session originally saw.
export async function discoverMemoryRulebook(
	timeline: TimelineEvent[],
	cwd: string,
	opts?: RulebookDiscoveryOptions,
): Promise<MemoryDiscoveryResult> {
	const paths = extractReadPaths(timeline, cwd, opts);
	const reads = [
		...[...paths.globalMemory].map((p) => readMemoryBlock(p, 'global-memory')),
		...[...paths.projectMemory].map((p) => readMemoryBlock(p, 'project-memory')),
		...[...paths.stack].map((p) => readMemoryBlock(p, 'stack')),
	];
	const blocks = (await Promise.all(reads)).filter(
		(block): block is MemoryRuleBlock => block !== null,
	);
	return { blocks, count: blocks.length };
}
