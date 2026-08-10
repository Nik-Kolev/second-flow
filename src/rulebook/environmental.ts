import type {
	AttachmentBucket,
	EnvironmentalRuleBlock,
	McpInstructionsDeltaAttachment,
	RuleBlock,
} from './types.js';

// entryIndex scopes the fallback key so two nameless delta entries never collide in the active map below.
function mcpKey(
	entry: McpInstructionsDeltaAttachment,
	entryIndex: number,
	blockIndex: number,
): string {
	return entry.addedNames?.[blockIndex] ?? `mcp:${entryIndex}:${blockIndex}`;
}

// Nets down to what's still connected — a disconnected server's block would generate findings against instructions that no longer applied.
function resolveMcpBlocks(deltas: McpInstructionsDeltaAttachment[]): RuleBlock[] {
	const active = new Map<string, EnvironmentalRuleBlock>();

	deltas.forEach((entry, entryIndex) => {
		for (const name of entry.removedNames ?? []) {
			active.delete(name);
		}
		(entry.addedBlocks ?? []).forEach((rawText, blockIndex) => {
			const text = rawText?.trim();
			if (!text) {
				return;
			}
			const key = mcpKey(entry, entryIndex, blockIndex);
			active.set(key, {
				origin: 'transcript',
				layer: 'environmental',
				sourceKind: 'mcp',
				source: key,
				text,
				meta: { uuid: entry.uuid, timestamp: entry.timestamp },
			});
		});
	});

	return [...active.values()];
}

export function extractEnvironmentalRuleBlocks(attachments: AttachmentBucket): RuleBlock[] {
	const blocks: RuleBlock[] = resolveMcpBlocks(attachments.mcpInstructionsDelta);

	for (const entry of attachments.skillListing) {
		const text = entry.content?.trim();
		if (!text) {
			continue;
		}
		blocks.push({
			origin: 'transcript',
			layer: 'environmental',
			sourceKind: 'skill',
			source: 'skill-listing',
			text,
			meta: { uuid: entry.uuid, timestamp: entry.timestamp, names: entry.names },
		});
	}

	for (const entry of attachments.outputStyle) {
		const text = entry.style?.trim();
		if (!text) {
			continue;
		}
		blocks.push({
			origin: 'transcript',
			layer: 'environmental',
			sourceKind: 'output-style',
			source: 'output-style',
			text,
			meta: { uuid: entry.uuid, timestamp: entry.timestamp },
		});
	}

	return blocks;
}
