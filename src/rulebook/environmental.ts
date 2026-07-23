import type {
	AttachmentBucket,
	EnvironmentalRuleBlock,
	McpInstructionsDeltaAttachment,
	RuleBlock,
} from './types.js';

// `entryIndex` (this entry's position among all deltas) scopes the fallback key so two different
// delta entries that both lack addedNames never collide — a bare `mcp:${blockIndex}` would let a
// later unnamed entry silently overwrite an earlier unrelated one in the active map below.
function mcpKey(
	entry: McpInstructionsDeltaAttachment,
	entryIndex: number,
	blockIndex: number,
): string {
	return entry.addedNames?.[blockIndex] ?? `mcp:${entryIndex}:${blockIndex}`;
}

// Nets `addedNames`/`removedNames` down to what's still connected by the end of the session —
// surfacing a block for an MCP server the user disconnected mid-session would generate findings
// against instructions that no longer applied, contradicting "audit against the current rulebook."
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
