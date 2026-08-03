import { createReadStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

export function resolveProjectsRoot(): string {
	const override = process.env.CLAUDE_PROJECTS_DIR?.trim();
	return override ? override : path.join(os.homedir(), '.claude', 'projects');
}

// Both callers below join this straight into a filesystem path — slug/sessionId are route params, so this blocks path traversal (e.g. "../../etc/passwd") before it ever reaches fs.
function assertSafePathSegment(value: string, label: string): void {
	if (value.length === 0 || value === '.' || value === '..' || /[/\\]/.test(value)) {
		throw new Error(`Invalid ${label}: "${value}"`);
	}
}

// Non-recursive readdir is the entire subagent-exclusion mechanism — CLAUDE.md, memory/, and `<session-id>/subagents/` sit alongside session files but are never seen.
export async function listSessionFiles(slug: string): Promise<string[]> {
	assertSafePathSegment(slug, 'slug');
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
	assertSafePathSegment(slug, 'slug');
	assertSafePathSegment(sessionId, 'sessionId');
	return path.join(resolveProjectsRoot(), slug, `${sessionId}.jsonl`);
}

// Reverse-engineered from observed directory names — not documented by Anthropic.
export function slugFromCwd(cwd: string): string {
	return cwd.replace(/[:\\/]/g, '-');
}

// Lossy — a literal hyphen in a folder name is indistinguishable from an encoded separator, so the transcript's own cwd field is the only place the real path survives.
// Line-bounded, not byte-bounded — a real transcript can front-load one 16KB+ metadata line before the first line carrying cwd, which would blow a byte budget before getting there.
const CWD_PEEK_LINE_LIMIT = 50;

// Best-effort, display-only — returns null (never throws) on any read/parse failure or if no line within CWD_PEEK_LINE_LIMIT carries a cwd.
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
