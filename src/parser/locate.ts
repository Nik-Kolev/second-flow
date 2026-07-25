import { createReadStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

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

// slugFromCwd is lossy — a literal hyphen inside a folder name (e.g. "second-flow") is
// indistinguishable from a path-separator hyphen once encoded, so the slug alone can never be
// decoded back into a real path. The transcript itself is the only place the real path survives.
//
// Bounded by LINE count, not byte count: a real transcript can open with a handful of tiny
// metadata-only records (mode/permission-mode/etc.) followed by one huge system-init record —
// observed in the wild at 16KB+ for a single line — which would blow past any fixed byte budget
// before ever reaching the first line that actually carries `cwd`. Capping the number of lines
// inspected instead means one oversized early line just costs one line's worth of JSON.parse, not
// a truncated read that never gets far enough to find anything.
const CWD_PEEK_LINE_LIMIT = 50;

/**
 * Best-effort read of a session's real `cwd`, for display purposes only — scans at most the first
 * `CWD_PEEK_LINE_LIMIT` lines (not the whole file, which may be many MB) and returns the first
 * `cwd` string found. Returns null on any read/parse failure or if none is found in that many
 * lines; callers must treat that as "unknown", not an error.
 */
export async function peekSessionCwd(filePath: string): Promise<string | null> {
	const rl = readline.createInterface({
		input: createReadStream(filePath, 'utf-8'),
		crlfDelay: Infinity,
	});
	try {
		let lineCount = 0;
		for await (const line of rl) {
			lineCount++;
			try {
				const record = JSON.parse(line) as { cwd?: unknown };
				if (typeof record.cwd === 'string' && record.cwd.length > 0) {
					return record.cwd;
				}
			} catch {
				// Not JSON, or no cwd field on this record — keep scanning.
			}
			if (lineCount >= CWD_PEEK_LINE_LIMIT) {
				break;
			}
		}
		return null;
	} catch {
		return null;
	} finally {
		rl.close();
	}
}
