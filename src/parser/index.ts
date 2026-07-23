import { createReadStream } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parseRecords } from './classify.js';
import { findLatestSessionFile, resolveSessionFilePath } from './locate.js';
import type { ParsedSession } from './types.js';

export * from './types.js';
export {
	findLatestSessionFile,
	listSessionFiles,
	resolveProjectsRoot,
	resolveSessionFilePath,
	slugFromCwd,
} from './locate.js';
export { scrubDeep, scrubText } from './scrub.js';
export { parseRecords } from './classify.js';

export async function parseSessionFile(
	filePath: string,
	opts?: { projectSlug?: string },
): Promise<ParsedSession> {
	const sessionId = path.basename(filePath, '.jsonl');
	const projectSlug = opts?.projectSlug ?? path.basename(path.dirname(filePath));
	const rl = readline.createInterface({
		input: createReadStream(filePath, 'utf-8'),
		crlfDelay: Infinity,
	});
	return parseRecords(rl, { sessionId, projectSlug, filePath });
}

export async function parseSession(slug: string, sessionId?: string): Promise<ParsedSession> {
	const filePath = sessionId
		? resolveSessionFilePath(slug, sessionId)
		: await findLatestSessionFile(slug);
	if (!filePath) {
		throw new Error(`No session files found for project slug "${slug}"`);
	}
	return parseSessionFile(filePath, { projectSlug: slug });
}
