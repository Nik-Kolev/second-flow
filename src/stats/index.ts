import type { ParsedSession } from '../parser/index.js';
import { computeAgentUsageStats } from './agents.js';
import { detectBoundaryCandidates } from './boundaries.js';
import { computeCacheRatioSeries, detectUnexplainedCacheDrops } from './cache.js';
import { computeContextBudgetSeries } from './context-budget.js';
import { computeRateLimitHits } from './rate-limits.js';
import type { SessionStats } from './types.js';

export * from './types.js';
export { computeAgentUsageStats, extractSubagentType, groupInvocationsByType } from './agents.js';
export { detectBoundaryCandidates, extractShellCommand, SHELL_TOOL_NAMES } from './boundaries.js';
export { computeCacheRatioSeries, detectUnexplainedCacheDrops } from './cache.js';
export {
	computeContextBudgetSeries,
	MODEL_CONTEXT_WINDOWS,
	turnContextTokens,
} from './context-budget.js';
export { computeRateLimitHits } from './rate-limits.js';

export function computeSessionStats(session: ParsedSession): SessionStats {
	const { timeline } = session;
	const cacheSeries = computeCacheRatioSeries(timeline);
	return {
		sessionId: session.sessionId,
		projectSlug: session.projectSlug,
		agents: computeAgentUsageStats(timeline),
		contextBudget: computeContextBudgetSeries(timeline),
		cache: {
			series: cacheSeries,
			unexplainedDrops: detectUnexplainedCacheDrops(timeline, cacheSeries),
		},
		rateLimitHits: computeRateLimitHits(timeline),
		boundaryCandidates: detectBoundaryCandidates(timeline),
	};
}
