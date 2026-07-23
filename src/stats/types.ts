import type { SubagentUsage } from '../parser/index.js';

export interface SubagentInvocation {
	toolUseId: string;
	subagentType?: string;
	callTimestamp: string;
	subagentModel?: string;
	usage?: SubagentUsage;
	resultStatus?: string;
}

export interface SubagentTypeSummary {
	subagentType?: string;
	invocationCount: number;
	invocations: SubagentInvocation[];
	isRepeatCandidate: boolean;
}

export interface AgentUsageStats {
	invocations: SubagentInvocation[];
	byType: SubagentTypeSummary[];
}

export interface ContextBudgetPoint {
	turnIndex: number;
	messageId: string;
	timestamp: string;
	model: string;
	contextTokens: number;
	contextWindowSize?: number;
	percentConsumed?: number;
}

export interface CacheRatioPoint {
	turnIndex: number;
	messageId: string;
	timestamp: string;
	inputTokens: number;
	cacheReadInputTokens: number;
	cacheReadRatio?: number;
}

export interface CacheDropEvent {
	fromTurnIndex: number;
	toTurnIndex: number;
	fromRatio: number;
	toRatio: number;
	drop: number;
}

export interface RateLimitHit {
	turnIndex: number;
	messageId: string;
	timestamp: string;
	apiErrorStatus?: number;
}

export type BoundaryCandidateKind =
	'git-commit' | 'git-push' | 'gh-pr-create' | 'subagent-completion';

export interface BoundaryCandidate {
	kind: BoundaryCandidateKind;
	toolUseId: string;
	timestamp: string;
	detail?: string;
}

export interface SessionStats {
	sessionId: string;
	projectSlug: string;
	agents: AgentUsageStats;
	contextBudget: ContextBudgetPoint[];
	cache: { series: CacheRatioPoint[]; unexplainedDrops: CacheDropEvent[] };
	rateLimitHits: RateLimitHit[];
	boundaryCandidates: BoundaryCandidate[];
}
