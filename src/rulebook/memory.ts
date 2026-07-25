import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TimelineEvent } from '../parser/index.js';
import { scrubText } from '../parser/index.js';
import { resolveGlobalMemoryDir, resolveProjectMemoryDir, resolveStackDir } from './locate.js';
import type { MemoryRuleBlock, RulebookDiscoveryOptions } from './types.js';

// Mirrors extractShellCommand's guard (src/stats/boundaries.ts) — input is `unknown` on every
// ToolCallEvent, so the typeof/null check must come before the cast, not after.
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

// Deliberately Read-only, not Grep/Glob — only a full Read actually puts a file's content into
// context; a Grep match snippet doesn't mean the file was seen. Relative file_path values are
// skipped: Claude Code's own Read tool always uses absolute paths, so a relative one can't be
// reliably matched against the resolved directories and signals unexpected data, not a real file.
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
		if (normalized.startsWith(dirs.globalMemory + path.sep)) {
			paths.globalMemory.add(normalized);
		} else if (normalized.startsWith(dirs.projectMemory + path.sep)) {
			paths.projectMemory.add(normalized);
		} else if (normalized.startsWith(dirs.stack + path.sep)) {
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

// Scope (which files) comes from the session's own transcript; content always comes from disk as
// of right now — never frozen to what the session originally saw, matching how CLAUDE.md already
// behaves, so every audit measures against the same live standard regardless of when it runs.
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
