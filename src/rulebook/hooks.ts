import type { HookRuleBlock, HookSuccessAttachment, RuleBlock } from './types.js';

// content/stdout already passed through classify.ts's scrubDeep() — re-scrubbing here would be dead work.
export function extractHookRuleBlocks(hookSuccess: HookSuccessAttachment[]): RuleBlock[] {
	const blocks: RuleBlock[] = [];

	for (const entry of hookSuccess) {
		if (entry.hookEvent !== 'SessionStart') {
			continue;
		}
		// `||`, not `??` — an empty `content` string must still fall through to `stdout`.
		const text = entry.content?.trim() || entry.stdout?.trim();
		if (!text) {
			continue;
		}
		const block: HookRuleBlock = {
			origin: 'hook',
			layer: 'user',
			source: entry.command ?? entry.hookName ?? 'session-start-hook',
			text,
			meta: {
				hookName: entry.hookName,
				hookEvent: entry.hookEvent,
				uuid: entry.uuid,
				timestamp: entry.timestamp,
			},
		};
		blocks.push(block);
	}

	return blocks;
}
