import type { AttachmentBucket } from '../parser/index.js';
import { discoverGlobalRulebook, discoverProjectRulebook } from './discover.js';
import { extractEnvironmentalRuleBlocks } from './environmental.js';
import { extractHookRuleBlocks } from './hooks.js';
import { resolveGlobalClaudeMdPath, resolveProjectClaudeMdPath } from './locate.js';
import type { RulebookContext, RulebookDiscoveryOptions, RulebookResolution } from './types.js';

export * from './types.js';
export { resolveGlobalClaudeMdPath, resolveProjectClaudeMdPath } from './locate.js';
export { discoverGlobalRulebook, discoverProjectRulebook } from './discover.js';
export { extractHookRuleBlocks } from './hooks.js';
export { extractEnvironmentalRuleBlocks } from './environmental.js';

export async function resolveRulebook(
	attachments: AttachmentBucket,
	meta: RulebookContext,
	opts?: RulebookDiscoveryOptions,
): Promise<RulebookResolution> {
	const [global, project] = await Promise.all([
		discoverGlobalRulebook(opts),
		meta.cwd
			? discoverProjectRulebook(meta.cwd)
			: Promise.resolve({ blocks: [], found: false }),
	]);
	const hookBlocks = extractHookRuleBlocks(attachments.hookSuccess);
	const environmentalBlocks = extractEnvironmentalRuleBlocks(attachments);

	return {
		blocks: [...global.blocks, ...project.blocks, ...hookBlocks, ...environmentalBlocks],
		sources: {
			global: { path: resolveGlobalClaudeMdPath(opts), found: global.found },
			project: {
				path: meta.cwd ? resolveProjectClaudeMdPath(meta.cwd) : null,
				found: project.found,
			},
			hook: { count: hookBlocks.length },
			environmental: { count: environmentalBlocks.length },
		},
	};
}
