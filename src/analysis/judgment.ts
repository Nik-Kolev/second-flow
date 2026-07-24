import type Anthropic from '@anthropic-ai/sdk';
import anthropicClient from '../lib/anthropic.js';
import prismaClient from '../lib/prisma.js';
import { AnalysisNoteKind } from '../generated/prisma/index.js';
import type { AssistantContentBlock, TimelineEvent } from '../parser/index.js';
import type { RulebookResolution } from '../rulebook/index.js';

const SONNET_MODEL = 'claude-sonnet-5';
const JUDGMENT_TOOL_NAME = 'report_judgment_findings';
export const JUDGMENT_PURPOSE = 'judgment';

interface JudgmentAnthropicClient {
	messages: {
		create(params: {
			model: string;
			max_tokens: number;
			tools: Anthropic.ToolUnion[];
			tool_choice: { type: 'tool'; name: string };
			messages: Array<{ role: 'user'; content: string }>;
		}): Promise<Anthropic.Message>;
	};
}

export interface JudgmentDeps {
	prisma?: typeof prismaClient;
	anthropic?: JudgmentAnthropicClient;
}

interface RuleRewriteProposalInput {
	targetRuleRef: string;
	targetTextSnapshot: string;
	proposedText: string;
	evidence: string;
}

interface NoteInput {
	evidence: string;
}

export interface JudgmentFindings {
	ruleRewriteProposals: RuleRewriteProposalInput[];
	complianceNotes: NoteInput[];
	environmentalInstructionIgnoredNotes: NoteInput[];
	promptCoachingNotes: NoteInput[];
}

export type JudgmentCallOutcome =
	| { outcome: 'completed'; findings: JudgmentFindings }
	| { outcome: 'errored'; usageLogged: boolean };

const MAX_FIELD_LENGTH = 300;

function truncate(text: string): string {
	return text.length > MAX_FIELD_LENGTH ? `${text.slice(0, MAX_FIELD_LENGTH)}…` : text;
}

// AssistantContentBlock's last variant is an open `{ type: string; ... }` catch-all that overlaps
// the named variants, so a `.filter` type guard alone doesn't narrow — cast explicitly instead.
function extractAssistantText(content: AssistantContentBlock[]): string {
	return content
		.filter((block) => block.type === 'text')
		.map((block) => (block as { type: 'text'; text: string }).text)
		.join(' ');
}

function serializeEvent(event: TimelineEvent): string {
	switch (event.kind) {
		case 'user-message':
			return `USER: ${truncate(event.text)}`;
		case 'assistant-turn':
			return `ASSISTANT: ${truncate(extractAssistantText(event.content))}`;
		case 'tool-call':
			return `TOOL_CALL[${event.toolName}]: ${truncate(JSON.stringify(event.input))}`;
		case 'slash-command':
			return `SLASH_COMMAND: /${event.commandName}${event.commandArgs ? ` ${event.commandArgs}` : ''}`;
		case 'system':
			return `SYSTEM[${event.subtype}]`;
	}
}

function serializeEvidenceWindow(evidenceWindow: TimelineEvent[]): string {
	return evidenceWindow.map(serializeEvent).join('\n');
}

function describeRulebook(rulebook: RulebookResolution): string {
	return rulebook.blocks
		.map((block) => {
			const targetability =
				block.origin === 'file'
					? `rewrite target: ${block.source}`
					: 'not user-editable — never a rewrite target';
			return `[${block.layer}/${block.origin}, ${targetability}]\n${block.text}`;
		})
		.join('\n\n---\n\n');
}

function buildJudgmentPrompt(
	rulebook: RulebookResolution,
	evidenceWindow: TimelineEvent[],
	flaggedSignals: string[],
): string {
	// Some trigger kinds (rate-limit hits, cache-ratio drops) aren't visible as text anywhere in
	// the evidence window itself — the window only shows the surrounding conversation, not the
	// quantitative fact that caused this window to be flagged in the first place.
	const signalsSection =
		flaggedSignals.length > 0
			? [
					'',
					'Flagged signals (not visible in the evidence text itself):',
					...flaggedSignals.map((signal) => `- ${signal}`),
				]
			: [];

	return [
		"Below is a user's Claude Code rulebook, followed by an evidence window from one of their",
		'sessions (only the turns around signals worth reviewing, not the full transcript). Report',
		'findings in four categories, evidence-grounded only — "no significant findings" in any',
		'category is valid and expected, never filled in for:',
		'',
		'- ruleRewriteProposals: a rule is too vague/weakly worded and the session shows it failing',
		'  to prevent a gap. targetRuleRef MUST be one of the blocks below marked "rewrite target"',
		'  — never a hook or environmental block, since those are not user-editable files.',
		'- complianceNotes: a rule is clear but was ignored or half-followed. No rewrite is implied —',
		'  the wording is fine, the behavior was not. This also covers scope-limiting (work far',
		'  outside the stated task).',
		'- environmentalInstructionIgnoredNotes: a stated MCP/output-style/skill instruction was',
		'  ignored. No rewrite is possible, only the evidence.',
		'- promptCoachingNotes: an under-specified user prompt had a concrete cost (extra turns,',
		'  clarifying questions). Secondary — never the headline finding.',
		'',
		'Rulebook:',
		describeRulebook(rulebook),
		...signalsSection,
		'',
		'Evidence window:',
		serializeEvidenceWindow(evidenceWindow),
	].join('\n');
}

function buildJudgmentTool(): Anthropic.ToolUnion {
	const noteArraySchema = {
		type: 'array' as const,
		items: {
			type: 'object' as const,
			properties: { evidence: { type: 'string' as const } },
			required: ['evidence'],
			additionalProperties: false,
		},
	};
	return {
		name: JUDGMENT_TOOL_NAME,
		description: 'Report evidence-grounded judgment findings for this session, by category.',
		input_schema: {
			type: 'object',
			properties: {
				ruleRewriteProposals: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							targetRuleRef: { type: 'string' },
							targetTextSnapshot: { type: 'string' },
							proposedText: { type: 'string' },
							evidence: { type: 'string' },
						},
						required: [
							'targetRuleRef',
							'targetTextSnapshot',
							'proposedText',
							'evidence',
						],
						additionalProperties: false,
					},
				},
				complianceNotes: noteArraySchema,
				environmentalInstructionIgnoredNotes: noteArraySchema,
				promptCoachingNotes: noteArraySchema,
			},
			required: [
				'ruleRewriteProposals',
				'complianceNotes',
				'environmentalInstructionIgnoredNotes',
				'promptCoachingNotes',
			],
			additionalProperties: false,
		},
		strict: true,
	};
}

async function callJudgmentModel(
	rulebook: RulebookResolution,
	evidenceWindow: TimelineEvent[],
	flaggedSignals: string[],
	anthropic: JudgmentAnthropicClient,
): Promise<Anthropic.Message> {
	return anthropic.messages.create({
		model: SONNET_MODEL,
		max_tokens: 4096,
		tools: [buildJudgmentTool()],
		tool_choice: { type: 'tool', name: JUDGMENT_TOOL_NAME },
		messages: [
			{
				role: 'user',
				content: buildJudgmentPrompt(rulebook, evidenceWindow, flaggedSignals),
			},
		],
	});
}

function validateNoteArray(value: unknown, fieldName: string): NoteInput[] {
	if (!Array.isArray(value)) {
		throw new Error(`Judgment classification's "${fieldName}" is not an array`);
	}
	return value.map((item) => {
		if (
			typeof item !== 'object' ||
			item === null ||
			typeof (item as { evidence?: unknown }).evidence !== 'string'
		) {
			throw new Error(
				`Judgment classification's "${fieldName}" has an entry missing a string evidence field`,
			);
		}
		return { evidence: (item as { evidence: string }).evidence };
	});
}

const PROPOSAL_STRING_FIELDS = [
	'targetRuleRef',
	'targetTextSnapshot',
	'proposedText',
	'evidence',
] as const;

function validateProposalArray(value: unknown): RuleRewriteProposalInput[] {
	if (!Array.isArray(value)) {
		throw new Error('Judgment classification\'s "ruleRewriteProposals" is not an array');
	}
	return value.map((item) => {
		if (typeof item !== 'object' || item === null) {
			throw new Error('A rule-rewrite proposal is not an object');
		}
		const record = item as Record<string, unknown>;
		for (const field of PROPOSAL_STRING_FIELDS) {
			if (typeof record[field] !== 'string') {
				throw new Error(`A rule-rewrite proposal is missing a string "${field}" field`);
			}
		}
		return {
			targetRuleRef: record.targetRuleRef as string,
			targetTextSnapshot: record.targetTextSnapshot as string,
			proposedText: record.proposedText as string,
			evidence: record.evidence as string,
		};
	});
}

// External-API boundary, same failure-mode reasoning as ledger.ts/activation.ts: a silently
// malformed response must not be treated as "no findings" — that would be a silent false negative.
function extractJudgmentFindings(response: Anthropic.Message): JudgmentFindings {
	const toolUseBlock = response.content.find(
		(block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
	);
	if (!toolUseBlock) {
		throw new Error('Judgment call returned no tool_use block');
	}
	const input = toolUseBlock.input;
	if (typeof input !== 'object' || input === null) {
		throw new Error('Judgment call returned a non-object tool input');
	}
	const record = input as Record<string, unknown>;
	return {
		ruleRewriteProposals: validateProposalArray(record.ruleRewriteProposals),
		complianceNotes: validateNoteArray(record.complianceNotes, 'complianceNotes'),
		environmentalInstructionIgnoredNotes: validateNoteArray(
			record.environmentalInstructionIgnoredNotes,
			'environmentalInstructionIgnoredNotes',
		),
		promptCoachingNotes: validateNoteArray(record.promptCoachingNotes, 'promptCoachingNotes'),
	};
}

// The forced tool-use schema has no way to constrain targetRuleRef to an enum of valid sources,
// so Sonnet's own string output is the only guard — a hallucinated or reworded path must not
// reach RuleProposal, since it would later fail ledger.ts's reconciliation lookup indistinguishably
// from a legitimately-moved file.
function validFileSources(rulebook: RulebookResolution): Set<string> {
	return new Set(
		rulebook.blocks.filter((block) => block.origin === 'file').map((block) => block.source),
	);
}

async function logAuditRunCall(
	auditRunId: string,
	usage: Anthropic.Usage,
	prisma: typeof prismaClient,
): Promise<void> {
	await prisma.auditRunCall.create({
		data: {
			auditRunId,
			model: SONNET_MODEL,
			purpose: JUDGMENT_PURPOSE,
			inputTokens: usage.input_tokens,
			outputTokens: usage.output_tokens,
			cacheReadTokens: usage.cache_read_input_tokens ?? 0,
			cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
		},
	});
}

export async function runJudgmentCall(
	auditRunId: string,
	rulebook: RulebookResolution,
	evidenceWindow: TimelineEvent[],
	flaggedSignals: string[],
	deps: JudgmentDeps = {},
): Promise<JudgmentCallOutcome> {
	const prisma = deps.prisma ?? prismaClient;
	const anthropic = deps.anthropic ?? anthropicClient;

	let response: Anthropic.Message;
	try {
		response = await callJudgmentModel(rulebook, evidenceWindow, flaggedSignals, anthropic);
	} catch {
		// The call itself never completed — no usage was ever billed, nothing to log.
		return { outcome: 'errored', usageLogged: false };
	}

	// The call succeeded and real tokens were spent, regardless of whether the response content
	// below parses cleanly — log the spend before attempting to interpret the findings.
	await logAuditRunCall(auditRunId, response.usage, prisma);

	try {
		const findings = extractJudgmentFindings(response);
		const validSources = validFileSources(rulebook);
		findings.ruleRewriteProposals = findings.ruleRewriteProposals.filter((proposal) =>
			validSources.has(proposal.targetRuleRef),
		);
		return { outcome: 'completed', findings };
	} catch {
		return { outcome: 'errored', usageLogged: true };
	}
}

export async function persistJudgmentFindings(
	auditedSessionId: string,
	findings: JudgmentFindings,
	prisma: typeof prismaClient,
): Promise<{ proposalsCreated: number; notesCreated: number }> {
	// Sequential, not Promise.all — same SQLite write-contention reasoning as reconcileProposals.
	for (const proposal of findings.ruleRewriteProposals) {
		await prisma.ruleProposal.create({
			data: {
				auditedSessionId,
				targetRuleRef: proposal.targetRuleRef,
				targetTextSnapshot: proposal.targetTextSnapshot,
				proposedText: proposal.proposedText,
				evidence: proposal.evidence,
			},
		});
	}

	const noteGroups: Array<[AnalysisNoteKind, NoteInput[]]> = [
		[AnalysisNoteKind.compliance, findings.complianceNotes],
		[AnalysisNoteKind.environmentalInstruction, findings.environmentalInstructionIgnoredNotes],
		[AnalysisNoteKind.promptCoaching, findings.promptCoachingNotes],
	];
	let notesCreated = 0;
	for (const [kind, notes] of noteGroups) {
		for (const note of notes) {
			await prisma.analysisNote.create({
				data: { auditedSessionId, kind, evidence: note.evidence },
			});
			notesCreated++;
		}
	}

	return { proposalsCreated: findings.ruleRewriteProposals.length, notesCreated };
}
