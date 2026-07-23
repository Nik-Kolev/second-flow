import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { TimelineEvent } from './types.js';

const MAX_LINES_SCANNED = 200;

export function resolveSubagentsDir(filePath: string, sessionId: string): string {
	return path.join(path.dirname(filePath), sessionId, 'subagents');
}

async function readFirstAssistantModel(jsonlPath: string): Promise<string | undefined> {
	try {
		const rl = readline.createInterface({
			input: createReadStream(jsonlPath, 'utf-8'),
			crlfDelay: Infinity,
		});
		try {
			let lineCount = 0;
			for await (const line of rl) {
				lineCount += 1;
				if (lineCount > MAX_LINES_SCANNED) {
					return undefined;
				}
				const trimmed = line.trim();
				if (!trimmed) {
					continue;
				}
				let record: Record<string, unknown>;
				try {
					record = JSON.parse(trimmed);
				} catch {
					continue;
				}
				if (record.type === 'assistant') {
					const message = record.message as { model?: unknown } | undefined;
					return typeof message?.model === 'string' ? message.model : undefined;
				}
			}
			return undefined;
		} finally {
			rl.close();
		}
	} catch {
		return undefined;
	}
}

interface SubagentSidecar {
	toolUseId?: unknown;
}

// A subagent's filename doesn't encode the tool-use id that spawned it — only its .meta.json
// sidecar does, so that's the join key. Never throws; any failure just leaves subagentModel unset.
export async function enrichSubagentModels(
	timeline: TimelineEvent[],
	filePath: string,
	sessionId: string,
): Promise<void> {
	const spawnCalls = timeline.filter(
		(event): event is Extract<TimelineEvent, { kind: 'tool-call' }> =>
			event.kind === 'tool-call' && event.isSubagentSpawn,
	);
	if (spawnCalls.length === 0) {
		return;
	}

	const subagentsDir = resolveSubagentsDir(filePath, sessionId);
	let entries;
	try {
		entries = await fs.readdir(subagentsDir, { withFileTypes: true });
	} catch {
		return;
	}

	const sidecarNames = entries
		.filter((entry) => entry.isFile() && entry.name.endsWith('.meta.json'))
		.map((entry) => entry.name);

	const toolUseIdToJsonlPath = new Map<string, string>();
	await Promise.all(
		sidecarNames.map(async (name) => {
			try {
				const raw = await fs.readFile(path.join(subagentsDir, name), 'utf-8');
				const meta = JSON.parse(raw) as SubagentSidecar;
				if (typeof meta.toolUseId === 'string') {
					const jsonlName = name.slice(0, -'.meta.json'.length) + '.jsonl';
					toolUseIdToJsonlPath.set(meta.toolUseId, path.join(subagentsDir, jsonlName));
				}
			} catch {
				// skip malformed sidecar
			}
		}),
	);

	await Promise.all(
		spawnCalls.map(async (call) => {
			const jsonlPath = toolUseIdToJsonlPath.get(call.toolUseId);
			if (!jsonlPath) {
				return;
			}
			call.subagentModel = await readFirstAssistantModel(jsonlPath);
		}),
	);
}
