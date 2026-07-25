import type { AttachmentBucket, TimelineEvent } from '../parser/index.js';
import { discoverGlobalRulebook, discoverProjectRulebook } from './discover.js';
import { extractEnvironmentalRuleBlocks } from './environmental.js';
import { extractHookRuleBlocks } from './hooks.js';
import { resolveGlobalClaudeMdPath, resolveProjectClaudeMdPath } from './locate.js';
import { discoverMemoryRulebook } from './memory.js';
import type { RulebookContext, RulebookDiscoveryOptions, RulebookResolution } from './types.js';

export * from './types.js';
export { resolveGlobalClaudeMdPath, resolveProjectClaudeMdPath } from './locate.js';
export { discoverGlobalRulebook, discoverProjectRulebook } from './discover.js';
export { extractHookRuleBlocks } from './hooks.js';
export { extractEnvironmentalRuleBlocks } from './environmental.js';
export { discoverMemoryRulebook, extractReadPaths } from './memory.js';

export async function resolveRulebook(
	attachments: AttachmentBucket,
	meta: RulebookContext,
	timeline: TimelineEvent[],
	opts?: RulebookDiscoveryOptions,
): Promise<RulebookResolution> {
	const [global, project, memory] = await Promise.all([
		discoverGlobalRulebook(opts),
		meta.cwd
			? discoverProjectRulebook(meta.cwd)
			: Promise.resolve({ blocks: [], found: false }),
		meta.cwd
			? discoverMemoryRulebook(timeline, meta.cwd, opts)
			: Promise.resolve({ blocks: [], count: 0 }),
	]);
	const hookBlocks = extractHookRuleBlocks(attachments.hookSuccess);
	const environmentalBlocks = extractEnvironmentalRuleBlocks(attachments);

	return {
		// Memory/stack blocks are appended last — anything downstream that depends on block
		// ordering (e.g. src/lint/activation.ts's rulebook-hash cache) keeps seeing the same
		// global/project/hook/environmental sequence it always has.
		blocks: [
			...global.blocks,
			...project.blocks,
			...hookBlocks,
			...environmentalBlocks,
			...memory.blocks,
		],
		sources: {
			global: { path: resolveGlobalClaudeMdPath(opts), found: global.found },
			project: {
				path: meta.cwd ? resolveProjectClaudeMdPath(meta.cwd) : null,
				found: project.found,
			},
			hook: { count: hookBlocks.length },
			environmental: { count: environmentalBlocks.length },
			memory: { count: memory.count },
		},
	};
}
