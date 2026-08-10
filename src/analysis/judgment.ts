import type Anthropic from '@anthropic-ai/sdk';
import anthropicClient from '../lib/anthropic.js';
import prismaClient from '../lib/prisma.js';
import { AnalysisNoteKind, NoteOutcome } from '../generated/prisma/index.js';
import type { AssistantContentBlock, TimelineEvent, ToolCallResult } from '../parser/index.js';
import type { RulebookResolution } from '../rulebook/index.js';
import { getAuditSettings } from './settings.js';

const JUDGMENT_TOOL_NAME = 'report_judgment_findings';
export const JUDGMENT_PURPOSE = 'judgment';

// Fallback ruleRef for notes with no file match, or an invalid model-invented value.
export const GENERAL_RULE_REF = 'general';

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
	// Explicit override wins over the persisted AuditSettings.judgmentModel — primarily for tests.
	judgmentModel?: string;
}

interface RuleRewriteProposalInput {
	targetRuleRef: string;
	targetTextSnapshot: string;
	proposedText: string;
	evidence: string;
}

// Model classifies outcome at generation time; one incident spanning both outcomes becomes two notes.
interface ComplianceOrEnvNoteInput {
	evidence: string;
	ruleRef: string;
	outcome: NoteOutcome;
}

interface PromptCoachingNoteInput {
	evidence: string;
	ruleRef: string;
	suggestion: string;
}

export interface JudgmentFindings {
	ruleRewriteProposals: RuleRewriteProposalInput[];
	complianceNotes: ComplianceOrEnvNoteInput[];
	environmentalInstructionIgnoredNotes: ComplianceOrEnvNoteInput[];
	promptCoachingNotes: PromptCoachingNoteInput[];
}

export type JudgmentCallOutcome =
	// droppedProposalCount distinguishes "found nothing" from "found some, filtered as invalid".
	| { outcome: 'completed'; findings: JudgmentFindings; droppedProposalCount: number }
	| { outcome: 'errored'; usageLogged: boolean };

// 600 (up from 300) — truncation was starving judgment of context; cost is capped by the window.
const MAX_FIELD_LENGTH = 600;

function truncate(text: string): string {
	return text.length > MAX_FIELD_LENGTH ? `${text.slice(0, MAX_FIELD_LENGTH)}…` : text;
}

// Guards a real flake where evidence: "placeholder" persisted unvalidated — real evidence is never this short.
const MIN_EVIDENCE_LENGTH = 20;

function isDegenerateEvidence(evidence: string): boolean {
	return evidence.trim().length < MIN_EVIDENCE_LENGTH;
}

// The catch-all variant overlaps named ones, so `.filter` alone can't narrow — cast explicitly.
function extractAssistantText(content: AssistantContentBlock[]): string {
	return content
		.filter((block) => block.type === 'text')
		.map((block) => (block as { type: 'text'; text: string }).text)
		.join(' ');
}

// Without this, a failed command (e.g. a failing "npm test") is indistinguishable from a passing one in the evidence text — the judgment model needs pass/fail to ground a "verify by running" finding.
function describeToolResult(result: ToolCallResult): string {
	switch (result.kind) {
		case 'pending':
			return '(pending)';
		case 'sync':
			return result.isError === true
				? `[FAILED] ${truncate(result.text)}`
				: truncate(result.text);
		case 'async-task-notification':
			return truncate(
				`${result.status ?? 'unknown'}${result.summary ? `: ${result.summary}` : ''}`,
			);
	}
}

function serializeEvent(event: TimelineEvent): string {
	switch (event.kind) {
		case 'user-message':
			return `USER: ${truncate(event.text)}`;
		case 'assistant-turn':
			return `ASSISTANT: ${truncate(extractAssistantText(event.content))}`;
		case 'tool-call':
			return `TOOL_CALL[${event.toolName}]: ${truncate(JSON.stringify(event.input))} → RESULT: ${describeToolResult(event.result)}`;
		case 'slash-command':
			return `SLASH_COMMAND: /${event.commandName}${event.commandArgs ? ` ${event.commandArgs}` : ''}`;
		case 'system':
			return `SYSTEM[${event.subtype}]`;
	}
}

function serializeEvidenceWindow(evidenceWindow: TimelineEvent[]): string {
	return evidenceWindow.map(serializeEvent).join('\n');
}

function describeBlockTargetability(block: RulebookResolution['blocks'][number]): string {
	if (block.origin === 'file') {
		return `rewrite target: ${block.source}`;
	}
	if (block.origin === 'memory') {
		return 'not a rewrite target — edit the memory/stack file directly';
	}
	return 'not user-editable — never a rewrite target';
}

function describeRulebook(rulebook: RulebookResolution): string {
	return rulebook.blocks
		.map(
			(block) =>
				`[${block.layer}/${block.origin}, ${describeBlockTargetability(block)}]\n${block.text}`,
		)
		.join('\n\n---\n\n');
}

function buildJudgmentPrompt(
	rulebook: RulebookResolution,
	evidenceWindow: TimelineEvent[],
	flaggedSignals: string[],
): string {
	// Some trigger kinds (rate-limit hits, cache-ratio drops) aren't visible as text in the evidence window itself.
	const signalsSection =
		flaggedSignals.length > 0
			? [
					'',
					'Flagged signals (not visible in the evidence text itself):',
					...flaggedSignals.map((signal) => `- ${signal}`),
				]
			: [];

	const fileSources = [...validRuleRefSources(rulebook)];

	return [
		"Below is a user's Claude Code rulebook, followed by an evidence window from one of their",
		'sessions (only the turns around signals worth reviewing, not the full transcript). Report',
		'findings in four categories, evidence-grounded only — "no significant findings" in any',
		'category is valid and expected, never filled in for:',
		'',
		'- ruleRewriteProposals: a rule is too vague/weakly worded and the session shows it failing',
		'  to prevent a gap. targetRuleRef MUST be one of the blocks below marked "rewrite target"',
		'  — never a hook or environmental block (not user-editable files) and never a memory/stack',
		'  block either (edited directly by the user, not through a rewrite proposal).',
		'- complianceNotes: an instance of a clear rule being followed or not — no rewrite implied,',
		'  the wording is fine either way. Set outcome to "violation" when the rule was ignored or',
		'  half-followed (this also covers scope-limiting: work far outside the stated task), or',
		'  "positive" when it was followed correctly and is worth confirming. If a single incident',
		'  contains both a compliant moment and a missed one (e.g. correct the first time, not',
		'  re-confirmed the second), report it as two separate notes — one "violation", one',
		'  "positive" — never one note conflating both.',
		'- environmentalInstructionIgnoredNotes: the same outcome field and violation/positive split',
		'  as complianceNotes, but for a stated MCP/output-style/skill instruction rather than a',
		'  CLAUDE.md rule. No rewrite is possible, only the evidence.',
		'- promptCoachingNotes: an under-specified user prompt had a concrete cost (extra turns,',
		'  clarifying questions). Secondary — never the headline finding. suggestion must be a',
		'  concrete rephrasing the user could have used instead, not just a restatement of the cost.',
		'',
		'Every note carries a ruleRef: the rulebook file the note is about, or exactly',
		`"${GENERAL_RULE_REF}" when it ties to no single file. Valid ruleRef values:`,
		...fileSources.map((source) => `- ${source}`),
		`- ${GENERAL_RULE_REF}`,
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
	const complianceOrEnvNoteArraySchema = {
		type: 'array' as const,
		items: {
			type: 'object' as const,
			properties: {
				evidence: { type: 'string' as const },
				ruleRef: { type: 'string' as const },
				outcome: { type: 'string' as const, enum: Object.values(NoteOutcome) },
			},
			required: ['evidence', 'ruleRef', 'outcome'],
			additionalProperties: false,
		},
	};
	const promptCoachingNoteArraySchema = {
		type: 'array' as const,
		items: {
			type: 'object' as const,
			properties: {
				evidence: { type: 'string' as const },
				ruleRef: { type: 'string' as const },
				suggestion: { type: 'string' as const },
			},
			required: ['evidence', 'ruleRef', 'suggestion'],
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
				complianceNotes: complianceOrEnvNoteArraySchema,
				environmentalInstructionIgnoredNotes: complianceOrEnvNoteArraySchema,
				promptCoachingNotes: promptCoachingNoteArraySchema,
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

export interface JudgmentRequestParams {
	model: string;
	max_tokens: number;
	tools: Anthropic.ToolUnion[];
	tool_choice: { type: 'tool'; name: string };
	messages: Array<{ role: 'user'; content: string }>;
}

// Exported so the preview route's free count_tokens estimate uses the exact same request shape, or it would drift.
export function buildJudgmentRequestParams(
	model: string,
	rulebook: RulebookResolution,
	evidenceWindow: TimelineEvent[],
	flaggedSignals: string[],
): JudgmentRequestParams {
	return {
		model,
		// 8192: at 4096, Opus 5 exhausted the budget on earlier fields, failing required-field validation.
		max_tokens: 8192,
		tools: [buildJudgmentTool()],
		tool_choice: { type: 'tool', name: JUDGMENT_TOOL_NAME },
		messages: [
			{
				role: 'user',
				content: buildJudgmentPrompt(rulebook, evidenceWindow, flaggedSignals),
			},
		],
	};
}

// Explicit override wins; DB read only happens otherwise, so tests/CLI can pin a model directly.
export async function resolveJudgmentModel(deps: JudgmentDeps = {}): Promise<string> {
	if (deps.judgmentModel) {
		return deps.judgmentModel;
	}
	return (await getAuditSettings(deps)).judgmentModel;
}

async function callJudgmentModel(
	model: string,
	rulebook: RulebookResolution,
	evidenceWindow: TimelineEvent[],
	flaggedSignals: string[],
	anthropic: JudgmentAnthropicClient,
): Promise<Anthropic.Message> {
	return anthropic.messages.create(
		buildJudgmentRequestParams(model, rulebook, evidenceWindow, flaggedSignals),
	);
}

const NOTE_OUTCOMES = new Set<string>(Object.values(NoteOutcome));

function validateComplianceOrEnvNoteArray(
	value: unknown,
	fieldName: string,
): ComplianceOrEnvNoteInput[] {
	if (!Array.isArray(value)) {
		throw new Error(`Judgment classification's "${fieldName}" is not an array`);
	}
	return value.map((item) => {
		if (
			typeof item !== 'object' ||
			item === null ||
			typeof (item as { evidence?: unknown }).evidence !== 'string' ||
			typeof (item as { ruleRef?: unknown }).ruleRef !== 'string' ||
			!NOTE_OUTCOMES.has((item as { outcome?: unknown }).outcome as string)
		) {
			throw new Error(
				`Judgment classification's "${fieldName}" has an entry missing a string evidence/ruleRef field or a valid outcome ("violation"/"positive")`,
			);
		}
		const record = item as { evidence: string; ruleRef: string; outcome: NoteOutcome };
		return { evidence: record.evidence, ruleRef: record.ruleRef, outcome: record.outcome };
	});
}

function validatePromptCoachingNoteArray(value: unknown): PromptCoachingNoteInput[] {
	if (!Array.isArray(value)) {
		throw new Error('Judgment classification\'s "promptCoachingNotes" is not an array');
	}
	return value.map((item) => {
		if (
			typeof item !== 'object' ||
			item === null ||
			typeof (item as { evidence?: unknown }).evidence !== 'string' ||
			typeof (item as { ruleRef?: unknown }).ruleRef !== 'string' ||
			typeof (item as { suggestion?: unknown }).suggestion !== 'string' ||
			(item as { suggestion: string }).suggestion.length === 0
		) {
			throw new Error(
				'Judgment classification\'s "promptCoachingNotes" has an entry missing a string evidence/ruleRef field or a non-empty suggestion',
			);
		}
		const record = item as { evidence: string; ruleRef: string; suggestion: string };
		return {
			evidence: record.evidence,
			ruleRef: record.ruleRef,
			suggestion: record.suggestion,
		};
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

// A silently malformed response must not read as "no findings" — that's a silent false negative.
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
		complianceNotes: validateComplianceOrEnvNoteArray(
			record.complianceNotes,
			'complianceNotes',
		),
		environmentalInstructionIgnoredNotes: validateComplianceOrEnvNoteArray(
			record.environmentalInstructionIgnoredNotes,
			'environmentalInstructionIgnoredNotes',
		),
		promptCoachingNotes: validatePromptCoachingNoteArray(record.promptCoachingNotes),
	};
}

// Guards against a hallucinated targetRuleRef — only real CLAUDE.md files are valid rewrite targets.
function rewriteTargetSources(rulebook: RulebookResolution): Set<string> {
	return new Set(
		rulebook.blocks.filter((block) => block.origin === 'file').map((block) => block.source),
	);
}

// Wider than rewriteTargetSources: a note may cite a memory/stack file, just never propose rewriting one.
function validRuleRefSources(rulebook: RulebookResolution): Set<string> {
	return new Set(
		rulebook.blocks
			.filter((block) => block.origin === 'file' || block.origin === 'memory')
			.map((block) => block.source),
	);
}

async function logAuditRunCall(
	auditRunId: string,
	model: string,
	usage: Anthropic.Usage,
	prisma: typeof prismaClient,
): Promise<string> {
	const call = await prisma.auditRunCall.create({
		data: {
			auditRunId,
			model,
			purpose: JUDGMENT_PURPOSE,
			inputTokens: usage.input_tokens,
			outputTokens: usage.output_tokens,
			cacheReadTokens: usage.cache_read_input_tokens ?? 0,
			cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
		},
	});
	return call.id;
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
	const model = await resolveJudgmentModel(deps);

	let response: Anthropic.Message;
	try {
		response = await callJudgmentModel(
			model,
			rulebook,
			evidenceWindow,
			flaggedSignals,
			anthropic,
		);
	} catch {
		// The call itself never completed — no usage was ever billed, nothing to log.
		return { outcome: 'errored', usageLogged: false };
	}

	// Log the spend before interpreting the response — tokens were billed regardless of parse outcome.
	const callId = await logAuditRunCall(auditRunId, model, response.usage, prisma);

	// Opus 5/Fable 5 can end with stop_reason 'refusal' and no tool_use block — treat as errored, not a misleading parse failure.
	if (response.stop_reason === 'refusal') {
		await prisma.auditRunCall.update({
			where: { id: callId },
			data: {
				rawResponse: JSON.stringify(response),
				errorText: `Model ${model} refused the request (stop_reason: refusal)`,
			},
		});
		return { outcome: 'errored', usageLogged: true };
	}

	try {
		const findings = extractJudgmentFindings(response);
		const rewriteSources = rewriteTargetSources(rulebook);
		const ruleRefSources = validRuleRefSources(rulebook);
		const returnedProposalCount = findings.ruleRewriteProposals.length;
		findings.ruleRewriteProposals = findings.ruleRewriteProposals.filter(
			(proposal) =>
				rewriteSources.has(proposal.targetRuleRef) &&
				!isDegenerateEvidence(proposal.evidence),
		);
		// Notes degrade instead of dropping — coerce an invented ruleRef to "general" so the note survives.
		for (const noteArray of [
			findings.complianceNotes,
			findings.environmentalInstructionIgnoredNotes,
			findings.promptCoachingNotes,
		]) {
			for (const note of noteArray) {
				if (note.ruleRef !== GENERAL_RULE_REF && !ruleRefSources.has(note.ruleRef)) {
					note.ruleRef = GENERAL_RULE_REF;
				}
			}
		}
		// Unlike ruleRef, degenerate evidence has no recoverable value — drop the note instead of degrading it.
		findings.complianceNotes = findings.complianceNotes.filter(
			(note) => !isDegenerateEvidence(note.evidence),
		);
		findings.environmentalInstructionIgnoredNotes =
			findings.environmentalInstructionIgnoredNotes.filter(
				(note) => !isDegenerateEvidence(note.evidence),
			);
		findings.promptCoachingNotes = findings.promptCoachingNotes.filter(
			(note) => !isDegenerateEvidence(note.evidence),
		);
		return {
			outcome: 'completed',
			findings,
			droppedProposalCount: returnedProposalCount - findings.ruleRewriteProposals.length,
		};
	} catch (error) {
		// Raw response must survive on the call row — without it, errored looks identical to "found nothing".
		await prisma.auditRunCall.update({
			where: { id: callId },
			data: {
				rawResponse: JSON.stringify(response),
				errorText: error instanceof Error ? error.message : String(error),
			},
		});
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

	const complianceOrEnvGroups: Array<[AnalysisNoteKind, ComplianceOrEnvNoteInput[]]> = [
		[AnalysisNoteKind.compliance, findings.complianceNotes],
		[AnalysisNoteKind.environmentalInstruction, findings.environmentalInstructionIgnoredNotes],
	];
	let notesCreated = 0;
	for (const [kind, notes] of complianceOrEnvGroups) {
		for (const note of notes) {
			await prisma.analysisNote.create({
				data: {
					auditedSessionId,
					kind,
					evidence: note.evidence,
					ruleRef: note.ruleRef,
					outcome: note.outcome,
				},
			});
			notesCreated++;
		}
	}
	for (const note of findings.promptCoachingNotes) {
		await prisma.analysisNote.create({
			data: {
				auditedSessionId,
				kind: AnalysisNoteKind.promptCoaching,
				evidence: note.evidence,
				ruleRef: note.ruleRef,
				suggestion: note.suggestion,
			},
		});
		notesCreated++;
	}

	return { proposalsCreated: findings.ruleRewriteProposals.length, notesCreated };
}
