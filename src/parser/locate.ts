import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function resolveProjectsRoot(): string {
	const override = process.env.CLAUDE_PROJECTS_DIR?.trim();
	return override ? override : path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Lists session files directly under a project slug's directory — never recursing into any
 * subdirectory. This one filter is the entire subagent-exclusion mechanism: a real project slug
 * directory also contains CLAUDE.md, memory/, and `<session-id>/subagents/` sitting right
 * alongside the session files, and a non-recursive readdir simply never sees into them.
 */
export async function listSessionFiles(slug: string): Promise<string[]> {
	const dir = path.join(resolveProjectsRoot(), slug);
	let entries;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new Error(`No Claude Code project directory found for slug "${slug}" at ${dir}`, {
				cause: error,
			});
		}
		throw error;
	}
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
		.map((entry) => path.join(dir, entry.name));
}

export async function findLatestSessionFile(slug: string): Promise<string | null> {
	const files = await listSessionFiles(slug);
	if (files.length === 0) {
		return null;
	}
	const withMtime = await Promise.all(
		files.map(async (file) => ({ file, mtimeMs: (await fs.stat(file)).mtimeMs })),
	);
	withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return withMtime[0].file;
}

export function resolveSessionFilePath(slug: string, sessionId: string): string {
	return path.join(resolveProjectsRoot(), slug, `${sessionId}.jsonl`);
}

/** Best-effort, reverse-engineered from observed directory names — not documented by Anthropic. */
export function slugFromCwd(cwd: string): string {
	return cwd.replace(/[:\\/]/g, '-');
}
