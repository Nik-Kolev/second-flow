import { promises as fs } from 'node:fs';
import path from 'node:path';
import { scrubText } from '../parser/index.js';
import { resolveGlobalClaudeMdPath, resolveProjectClaudeMdPath } from './locate.js';
import type {
	FileDiscoveryResult,
	FileRuleBlock,
	RuleBlock,
	RulebookDiscoveryOptions,
} from './types.js';

async function readClaudeMdFile(filePath: string): Promise<string | null> {
	try {
		return await fs.readFile(filePath, 'utf-8');
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ENOTDIR') {
			return null;
		}
		throw error;
	}
}

function toFileBlock(layer: 'user' | 'project', source: string, raw: string): RuleBlock | null {
	const text = scrubText(raw.trim());
	if (!text) {
		return null;
	}
	const block: FileRuleBlock = { origin: 'file', layer, source, text };
	return block;
}

export async function discoverGlobalRulebook(
	opts?: RulebookDiscoveryOptions,
): Promise<FileDiscoveryResult> {
	const filePath = resolveGlobalClaudeMdPath(opts);
	const raw = await readClaudeMdFile(filePath);
	if (raw === null) {
		return { blocks: [], found: false };
	}
	const block = toFileBlock('user', filePath, raw);
	return { blocks: block ? [block] : [], found: true };
}

export async function discoverProjectRulebook(cwd: string): Promise<FileDiscoveryResult> {
	if (!path.isAbsolute(cwd)) {
		return { blocks: [], found: false };
	}
	const filePath = resolveProjectClaudeMdPath(cwd);
	const raw = await readClaudeMdFile(filePath);
	if (raw === null) {
		return { blocks: [], found: false };
	}
	const block = toFileBlock('project', filePath, raw);
	return { blocks: block ? [block] : [], found: true };
}
