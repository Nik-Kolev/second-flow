// Raw JSONL record shapes, loosely typed — every raw type keeps an open index signature since the format evolves across versions.

export interface RawUsage {
	input_tokens: number;
	output_tokens: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
	model?: string;
	[key: string]: unknown;
}

export type RawAssistantContentBlock =
	| { type: 'thinking'; thinking: string; [key: string]: unknown }
	| { type: 'text'; text: string }
	| { type: 'tool_use'; id: string; name: string; input: unknown }
	| { type: string; [key: string]: unknown };

export interface RawAssistantRecord {
	type: 'assistant';
	message: {
		id: string;
		model: string;
		role: 'assistant';
		content: RawAssistantContentBlock[];
		usage: RawUsage;
	};
	effort?: string;
	uuid: string;
	timestamp: string;
	error?: string;
	isApiErrorMessage?: boolean;
	apiErrorStatus?: number;
	[key: string]: unknown;
}

export type RawUserContentBlock =
	| {
			type: 'tool_result';
			tool_use_id: string;
			content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
	  }
	| { type: string; [key: string]: unknown };

export interface RawUserRecord {
	type: 'user';
	message: { role: 'user'; content: string | RawUserContentBlock[] };
	uuid?: string;
	timestamp?: string;
	origin?: { kind: string; [key: string]: unknown };
	toolUseResult?: unknown;
	[key: string]: unknown;
}

export interface RawSystemRecord {
	type: 'system';
	subtype: string;
	durationMs?: number;
	messageCount?: number;
	uuid?: string;
	timestamp?: string;
	[key: string]: unknown;
}

export interface RawAttachmentRecord {
	type: 'attachment';
	attachment: { type: string; [key: string]: unknown };
	uuid?: string;
	timestamp?: string;
	[key: string]: unknown;
}

// Output shapes — what this module hands back to callers.

export interface UsageInfo {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	model?: string;
	raw: RawUsage;
}

export type AssistantContentBlock =
	| { type: 'thinking'; thinking: string }
	| { type: 'text'; text: string }
	| { type: 'tool_use'; id: string; name: string; input: unknown }
	| { type: string; [key: string]: unknown };

export interface AssistantTurnEvent {
	kind: 'assistant-turn';
	messageId: string;
	uuid: string;
	timestamp: string;
	model: string;
	effort?: string;
	usage: UsageInfo;
	content: AssistantContentBlock[];
	// model is the sentinel "<synthetic>" on rate-limited turns, not a real model name.
	rateLimited?: boolean;
	apiErrorStatus?: number;
}

export interface UserMessageEvent {
	kind: 'user-message';
	uuid?: string;
	timestamp?: string;
	text: string;
}

export interface SlashCommandEvent {
	kind: 'slash-command';
	uuid?: string;
	timestamp?: string;
	commandName: string;
	commandMessage?: string;
	commandArgs?: string;
}

export interface SystemEvent {
	kind: 'system';
	subtype: string;
	uuid?: string;
	timestamp?: string;
	durationMs?: number;
	messageCount?: number;
	raw: RawSystemRecord;
}

export interface SubagentUsage {
	subagentTokens?: number;
	toolUses?: number;
	durationMs?: number;
}

export type ToolCallResult =
	| { kind: 'pending' }
	| { kind: 'sync'; timestamp?: string; text: string; raw?: unknown }
	| {
			kind: 'async-task-notification';
			timestamp?: string;
			taskId?: string;
			status?: string;
			summary?: string;
			outputFile?: string;
			result?: string;
			usage?: SubagentUsage;
	  };

export interface ToolCallEvent {
	kind: 'tool-call';
	toolUseId: string;
	toolName: string;
	input: unknown;
	callerUuid: string;
	callTimestamp: string;
	isSubagentSpawn: boolean;
	isBackground: boolean;
	result: ToolCallResult;
	// Best-effort, see subagent-model.ts — unset if subagent data is missing/malformed.
	subagentModel?: string;
}

export type TimelineEvent =
	UserMessageEvent | AssistantTurnEvent | ToolCallEvent | SlashCommandEvent | SystemEvent;

export interface HookSuccessAttachment {
	hookName?: string;
	hookEvent?: string;
	toolUseID?: string;
	content?: string;
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	command?: string;
	durationMs?: number;
	uuid?: string;
	timestamp?: string;
}

export interface SkillListingAttachment {
	content?: string;
	skillCount?: number;
	isInitial?: boolean;
	names?: string[];
	uuid?: string;
	timestamp?: string;
}

export interface DeferredToolsDeltaAttachment {
	addedNames?: string[];
	addedLines?: string[];
	removedNames?: string[];
	readdedNames?: string[];
	pendingMcpServers?: string[];
	uuid?: string;
	timestamp?: string;
}

export interface AgentListingDeltaAttachment {
	addedTypes?: string[];
	addedLines?: string[];
	removedTypes?: string[];
	isInitial?: boolean;
	showConcurrencyNote?: boolean;
	uuid?: string;
	timestamp?: string;
}

export interface McpInstructionsDeltaAttachment {
	addedNames?: string[];
	addedBlocks?: string[];
	removedNames?: string[];
	uuid?: string;
	timestamp?: string;
}

export interface OutputStyleAttachment {
	style: string;
	uuid?: string;
	timestamp?: string;
}

export interface UnknownAttachment {
	attachmentType: string;
	uuid?: string;
	timestamp?: string;
}

export interface AttachmentBucket {
	hookSuccess: HookSuccessAttachment[];
	skillListing: SkillListingAttachment[];
	deferredToolsDelta: DeferredToolsDeltaAttachment[];
	agentListingDelta: AgentListingDeltaAttachment[];
	mcpInstructionsDelta: McpInstructionsDeltaAttachment[];
	outputStyle: OutputStyleAttachment[];
	unknown: UnknownAttachment[];
}

export interface ParsedSession {
	sessionId: string;
	projectSlug: string;
	filePath: string;
	timeline: TimelineEvent[];
	attachments: AttachmentBucket;
	noise: { count: number; byType: Record<string, number> };
	meta: { aiTitles: string[]; cwd?: string; gitBranch?: string; version?: string };
}
