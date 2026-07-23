import { scrubDeep, scrubText } from './scrub.js';
import { parseTaskNotification } from './task-notification.js';
import type {
	AssistantContentBlock,
	AssistantTurnEvent,
	AttachmentBucket,
	ParsedSession,
	RawAssistantRecord,
	RawAttachmentRecord,
	RawSystemRecord,
	RawUsage,
	RawUserRecord,
	SlashCommandEvent,
	TimelineEvent,
	ToolCallEvent,
	UsageInfo,
	UserMessageEvent,
} from './types.js';

// Pure session-state bookkeeping — no conversational or rulebook content, always discarded.
// `queue-operation` is included here: its enqueue/dequeue pair only ever duplicates timing
// around a real event that also arrives as a `user`/`assistant` record (verified against real
// transcripts), so its content never needs inspecting.
const NOISE_TYPES = new Set([
	'last-prompt',
	'mode',
	'permission-mode',
	'file-history-snapshot',
	'file-history-delta',
	'queue-operation',
]);

type NoiseFn = (key: string) => void;

function emptyAttachmentBucket(): AttachmentBucket {
	return {
		hookSuccess: [],
		skillListing: [],
		deferredToolsDelta: [],
		agentListingDelta: [],
		mcpInstructionsDelta: [],
		outputStyle: [],
		unknown: [],
	};
}

function toUsageInfo(raw: RawUsage): UsageInfo {
	return {
		inputTokens: raw.input_tokens,
		outputTokens: raw.output_tokens,
		cacheReadInputTokens: raw.cache_read_input_tokens,
		cacheCreationInputTokens: raw.cache_creation_input_tokens,
		model: raw.model,
		raw,
	};
}

function extractText(
	content: string | Array<{ type: string; text?: string; [key: string]: unknown }>,
): string {
	if (typeof content === 'string') {
		return content;
	}
	return content
		.map((block) => (typeof block.text === 'string' ? block.text : ''))
		.filter(Boolean)
		.join('\n');
}

function handleAttachment(
	record: RawAttachmentRecord,
	attachments: AttachmentBucket,
	noise: NoiseFn,
): void {
	const { attachment, uuid, timestamp } = record;
	const scrubbed = scrubDeep(attachment) as Record<string, unknown>;
	const base = { ...scrubbed, uuid, timestamp };

	switch (attachment.type) {
		case 'hook_success':
			attachments.hookSuccess.push(base);
			return;
		case 'skill_listing':
			attachments.skillListing.push(base);
			return;
		case 'deferred_tools_delta':
			attachments.deferredToolsDelta.push(base);
			return;
		case 'agent_listing_delta':
			attachments.agentListingDelta.push(base);
			return;
		case 'mcp_instructions_delta':
			attachments.mcpInstructionsDelta.push(base);
			return;
		case 'output_style': {
			const style = typeof scrubbed.style === 'string' ? scrubbed.style : '';
			const last = attachments.outputStyle.at(-1);
			if (!last || last.style !== style) {
				attachments.outputStyle.push({ style, uuid, timestamp });
			} else {
				noise('attachment:output_style:repeat');
			}
			return;
		}
		default:
			attachments.unknown.push({ attachmentType: attachment.type, uuid, timestamp });
			noise(`attachment:${attachment.type}`);
	}
}

function handleAssistantRecord(
	record: RawAssistantRecord,
	timeline: TimelineEvent[],
	pendingAssistantTurn: AssistantTurnEvent | null,
	pendingToolCalls: Map<string, ToolCallEvent>,
): AssistantTurnEvent {
	const { message, uuid, timestamp, effort, error, isApiErrorMessage, apiErrorStatus } = record;

	// A single logical API response is persisted as several consecutive `assistant` lines (one
	// content block each), sharing one `message.id` and repeating the same `usage` object — group
	// them into one turn instead of triple-counting tokens.
	let turn = pendingAssistantTurn;
	if (!turn || turn.messageId !== message.id) {
		turn = {
			kind: 'assistant-turn',
			messageId: message.id,
			uuid,
			timestamp,
			model: message.model,
			effort,
			usage: toUsageInfo(message.usage),
			content: [],
			// Rate-limit records are always their own single turn, verified — safe to set only here.
			rateLimited: isApiErrorMessage === true && error === 'rate_limit',
			apiErrorStatus: typeof apiErrorStatus === 'number' ? apiErrorStatus : undefined,
		};
		timeline.push(turn);
	}

	for (const block of message.content) {
		if (block.type === 'thinking') {
			const thinkingBlock = block as { type: 'thinking'; thinking: string };
			turn.content.push({ type: 'thinking', thinking: scrubText(thinkingBlock.thinking) });
			continue;
		}
		if (block.type === 'text') {
			const textBlock = block as { type: 'text'; text: string };
			turn.content.push({ type: 'text', text: scrubText(textBlock.text) });
			continue;
		}
		if (block.type === 'tool_use') {
			const toolUseBlock = block as {
				type: 'tool_use';
				id: string;
				name: string;
				input: unknown;
			};
			const scrubbedInput = scrubDeep(toolUseBlock.input);
			turn.content.push({
				type: 'tool_use',
				id: toolUseBlock.id,
				name: toolUseBlock.name,
				input: scrubbedInput,
			});

			const toolCall: ToolCallEvent = {
				kind: 'tool-call',
				toolUseId: toolUseBlock.id,
				toolName: toolUseBlock.name,
				input: scrubbedInput,
				callerUuid: uuid,
				callTimestamp: timestamp,
				isSubagentSpawn: toolUseBlock.name === 'Agent' || toolUseBlock.name === 'Task',
				isBackground: Boolean(
					(scrubbedInput as { run_in_background?: boolean } | undefined)
						?.run_in_background,
				),
				result: { kind: 'pending' },
			};
			timeline.push(toolCall);
			pendingToolCalls.set(toolUseBlock.id, toolCall);
			continue;
		}
		turn.content.push(block as AssistantContentBlock);
	}

	return turn;
}

function parseSlashCommand(content: string, uuid?: string, timestamp?: string): SlashCommandEvent {
	const nameMatch = content.match(/<command-name>([\s\S]*?)<\/command-name>/);
	const messageMatch = content.match(/<command-message>([\s\S]*?)<\/command-message>/);
	const argsMatch = content.match(/<command-args>([\s\S]*?)<\/command-args>/);
	return {
		kind: 'slash-command',
		uuid,
		timestamp,
		commandName: (nameMatch?.[1] ?? '').trim(),
		commandMessage: messageMatch?.[1]?.trim(),
		commandArgs: argsMatch?.[1]?.trim(),
	};
}

function applyTaskNotification(
	content: string,
	timestamp: string | undefined,
	pendingToolCalls: Map<string, ToolCallEvent>,
	noise: NoiseFn,
): void {
	const info = parseTaskNotification(content);
	if (!info?.toolUseId) {
		noise('task-notification:unparseable');
		return;
	}
	const pending = pendingToolCalls.get(info.toolUseId);
	if (!pending) {
		noise('task-notification:orphan');
		return;
	}
	// The note embedded in real task-notifications states a resumed background agent can notify
	// more than once for the same tool-use-id — tolerate repeats, last write wins.
	pending.result = {
		kind: 'async-task-notification',
		timestamp,
		taskId: info.taskId,
		status: info.status,
		summary: info.summary,
		outputFile: info.outputFile,
		result: info.result,
		usage: info.usage,
	};
	if (info.status === 'completed' || info.status === 'failed') {
		pendingToolCalls.delete(info.toolUseId);
	}
}

function handleUserRecord(
	record: RawUserRecord,
	timeline: TimelineEvent[],
	pendingToolCalls: Map<string, ToolCallEvent>,
	noise: NoiseFn,
): void {
	const { message, uuid, timestamp, origin, toolUseResult } = record;
	const content = message.content;

	if (typeof content === 'string') {
		if (content.startsWith('<command-name>')) {
			timeline.push(parseSlashCommand(content, uuid, timestamp));
			return;
		}
		if (origin?.kind === 'task-notification' || content.startsWith('<task-notification>')) {
			applyTaskNotification(content, timestamp, pendingToolCalls, noise);
			return;
		}
		const userMessage: UserMessageEvent = {
			kind: 'user-message',
			uuid,
			timestamp,
			text: scrubText(content),
		};
		timeline.push(userMessage);
		return;
	}

	const toolResultBlocks = content.filter(
		(block): block is Extract<(typeof content)[number], { type: 'tool_result' }> =>
			block.type === 'tool_result',
	);

	if (toolResultBlocks.length > 0) {
		// `toolUseResult` is a single sibling field on the record. Every real record observed so
		// far carries exactly one tool_result block, and `toolUseResult` corresponds 1:1 to it —
		// no real example of multiple tool_result blocks in one record has been found (verified
		// across every transcript on this machine), but the code stays defensive in case that
		// assumption is ever wrong: the async-launch detection and the raw `toolUseResult`
		// passthrough only apply when there's exactly one block, since attributing one shared
		// field to more than one distinct call would be a guess, not a fact.
		const isSingleBlock = toolResultBlocks.length === 1;
		const asyncAck = toolUseResult as { isAsync?: boolean; status?: string } | undefined;

		for (const block of toolResultBlocks) {
			const pending = pendingToolCalls.get(block.tool_use_id);
			if (!pending) {
				noise('orphan-tool-result');
				continue;
			}

			// An async-launched call (background Agent/Bash) first returns an immediate "launched
			// successfully" acknowledgment here, not its real result — the actual result arrives
			// later via a task-notification record. Detected structurally via the sibling
			// `toolUseResult` field, not by guessing from the call's own input (which doesn't
			// reliably carry a run_in_background flag). Leave the call pending so the later
			// notification can resolve it.
			if (
				isSingleBlock &&
				asyncAck?.isAsync === true &&
				asyncAck.status === 'async_launched'
			) {
				pending.isBackground = true;
				continue;
			}

			const text = scrubText(extractText(block.content));
			const rawResult =
				isSingleBlock && toolUseResult !== undefined ? scrubDeep(toolUseResult) : undefined;
			pending.result = { kind: 'sync', timestamp, text, raw: rawResult };
			pendingToolCalls.delete(block.tool_use_id);
		}
		return;
	}

	const text = extractText(
		content as Array<{ type: string; text?: string; [key: string]: unknown }>,
	);
	if (text) {
		timeline.push({ kind: 'user-message', uuid, timestamp, text: scrubText(text) });
	} else {
		noise('user:unrecognized-content-shape');
	}
}

export async function parseRecords(
	lines: AsyncIterable<string> | Iterable<string>,
	context: { sessionId: string; projectSlug: string; filePath: string },
): Promise<ParsedSession> {
	const timeline: TimelineEvent[] = [];
	const attachments = emptyAttachmentBucket();
	const noiseCounts: Record<string, number> = {};
	let noiseTotal = 0;
	const pendingToolCalls = new Map<string, ToolCallEvent>();
	let pendingAssistantTurn: AssistantTurnEvent | null = null;
	const aiTitles: string[] = [];
	let cwd: string | undefined;
	let gitBranch: string | undefined;
	let version: string | undefined;

	const noise: NoiseFn = (key) => {
		noiseTotal += 1;
		noiseCounts[key] = (noiseCounts[key] ?? 0) + 1;
	};

	for await (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}

		let record: Record<string, unknown>;
		try {
			record = JSON.parse(trimmed);
		} catch {
			noise('unparseable-line');
			continue;
		}

		if (!cwd && typeof record.cwd === 'string') cwd = record.cwd;
		if (!gitBranch && typeof record.gitBranch === 'string') gitBranch = record.gitBranch;
		if (!version && typeof record.version === 'string') version = record.version;

		const type = record.type;
		if (typeof type !== 'string') {
			noise('untyped-record');
			continue;
		}

		if (NOISE_TYPES.has(type)) {
			noise(type);
			continue;
		}

		if (type === 'ai-title') {
			const title = record.title;
			if (typeof title === 'string') {
				aiTitles.push(title);
			}
			continue;
		}

		if (type === 'attachment') {
			handleAttachment(record as unknown as RawAttachmentRecord, attachments, noise);
			continue;
		}

		if (type === 'system') {
			const sys = record as unknown as RawSystemRecord;
			timeline.push({
				kind: 'system',
				subtype: sys.subtype,
				uuid: sys.uuid,
				timestamp: sys.timestamp,
				durationMs: sys.durationMs,
				messageCount: sys.messageCount,
				raw: sys,
			});
			continue;
		}

		if (type === 'assistant') {
			pendingAssistantTurn = handleAssistantRecord(
				record as unknown as RawAssistantRecord,
				timeline,
				pendingAssistantTurn,
				pendingToolCalls,
			);
			continue;
		}

		if (type === 'user') {
			handleUserRecord(record as unknown as RawUserRecord, timeline, pendingToolCalls, noise);
			continue;
		}

		noise(`unrecognized-type:${type}`);
	}

	return {
		sessionId: context.sessionId,
		projectSlug: context.projectSlug,
		filePath: context.filePath,
		timeline,
		attachments,
		noise: { count: noiseTotal, byType: noiseCounts },
		meta: { aiTitles, cwd, gitBranch, version },
	};
}
