import { promises as fs } from 'node:fs';
import type Anthropic from '@anthropic-ai/sdk';
import anthropicClient from '../lib/anthropic.js';
import prismaClient from '../lib/prisma.js';
import type { AuditRun, RuleProposal } from '../generated/prisma/index.js';
import { RuleProposalStatus } from '../generated/prisma/index.js';

const HAIKU_MODEL = 'claude-haiku-4-5';
const RECONCILIATION_TOOL_NAME = 'report_reconciliation';
export const RECONCILIATION_PURPOSE = 'reconciliation';

interface ReconciliationAnthropicClient {
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

export interface LedgerDeps {
	prisma?: typeof prismaClient;
	anthropic?: ReconciliationAnthropicClient;
}

export interface ReconciliationSummary {
	totalProposed: number;
	noOp: number;
	resolved: number;
	stillProposed: number;
	needsConfirm: number;
	errored: number;
	haikuCallsMade: number;
}

type ReconciliationOutcome =
	| { kind: 'noOp' }
	| { kind: 'resolved' }
	| { kind: 'stillProposed' }
	| { kind: 'needsConfirm' }
	// usageLogged distinguishes a call that was actually billed (parse failure after a real
	// response came back) from one that never completed (network/call failure, nothing billed) —
	// haikuCallsMade below must only count the former.
	| { kind: 'errored'; usageLogged: boolean };

// Mirrors src/rulebook/discover.ts's read-or-null convention: a missing/unreadable target file is
// an expected steady-state case here (the rule file may have been deleted or restructured since
// the proposal was made), not an error — the caller maps a null read to `needsConfirm` rather
// than crashing the whole reconciliation pass over one bad proposal.
async function readCurrentFileText(filePath: string): Promise<string | null> {
	try {
		return await fs.readFile(filePath, 'utf-8');
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ENOTDIR') {
			return null;
		}
		throw error;
	}
}

function buildReconciliationPrompt(proposal: RuleProposal, currentFileText: string): string {
	return [
		'A prior audit flagged the wording below in a rulebook/instruction file as failing to',
		"prevent a specific gap, and proposed a fix. The file's wording has since changed. Decide",
		"whether the user's edit actually addresses the original concern — not just whether the",
		'flagged wording moved or was reworded without fixing the underlying gap.',
		'',
		'Original flagged wording (no longer found verbatim in the current file):',
		proposal.targetTextSnapshot,
		'',
		'Proposed fix at the time this was flagged:',
		proposal.proposedText,
		'',
		'Original evidence for why this was flagged:',
		proposal.evidence,
		'',
		'Current full text of the file:',
		currentFileText,
	].join('\n');
}

async function callReconciliationModel(
	proposal: RuleProposal,
	currentFileText: string,
	anthropic: ReconciliationAnthropicClient,
): Promise<Anthropic.Message> {
	return anthropic.messages.create({
		model: HAIKU_MODEL,
		max_tokens: 1024,
		tools: [
			{
				name: RECONCILIATION_TOOL_NAME,
				description:
					"Report whether the user's current edits to this file address the original " +
					'flagged concern.',
				input_schema: {
					type: 'object',
					properties: { addressed: { type: 'boolean' } },
					required: ['addressed'],
					additionalProperties: false,
				},
				strict: true,
			},
		],
		tool_choice: { type: 'tool', name: RECONCILIATION_TOOL_NAME },
		messages: [{ role: 'user', content: buildReconciliationPrompt(proposal, currentFileText) }],
	});
}

// External-API boundary, same failure-mode reasoning as src/lint/activation.ts: a silently
// malformed response here must not be treated as a default answer either way — a wrong guess
// would either falsely resolve a real gap or falsely keep chasing one that's already fixed.
function extractAddressedVerdict(response: Anthropic.Message): boolean {
	const toolUseBlock = response.content.find(
		(block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
	);
	if (!toolUseBlock) {
		throw new Error('Reconciliation classification call returned no tool_use block');
	}
	const input = toolUseBlock.input;
	if (typeof input !== 'object' || input === null) {
		throw new Error('Reconciliation classification returned a non-object tool input');
	}
	const addressed = (input as Record<string, unknown>).addressed;
	if (typeof addressed !== 'boolean') {
		throw new Error('Reconciliation classification is missing a boolean "addressed" field');
	}
	return addressed;
}

async function logAuditRunCall(
	auditRunId: string,
	usage: Anthropic.Usage,
	prisma: typeof prismaClient,
): Promise<void> {
	await prisma.auditRunCall.create({
		data: {
			auditRunId,
			model: HAIKU_MODEL,
			purpose: RECONCILIATION_PURPOSE,
			inputTokens: usage.input_tokens,
			outputTokens: usage.output_tokens,
			cacheReadTokens: usage.cache_read_input_tokens ?? 0,
			cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
		},
	});
}

async function reconcileOneProposal(
	proposal: RuleProposal,
	auditRunId: string,
	prisma: typeof prismaClient,
	anthropic: ReconciliationAnthropicClient,
): Promise<ReconciliationOutcome> {
	let currentText: string | null;
	try {
		currentText = await readCurrentFileText(proposal.targetRuleRef);
	} catch {
		// An unexpected fs error (EACCES, EISDIR, ...) on this one proposal's target file — same
		// isolation philosophy as the Haiku-call failures below: it must not abort reconciliation
		// of every other unrelated proposal in this batch.
		return { kind: 'errored', usageLogged: false };
	}

	if (currentText === null) {
		await prisma.ruleProposal.update({
			where: { id: proposal.id },
			data: { status: RuleProposalStatus.needsConfirm },
		});
		return { kind: 'needsConfirm' };
	}

	// An empty snapshot can never meaningfully be "still present" — guard against
	// String.includes('') always vacuously matching and falsely reporting a no-op.
	if (proposal.targetTextSnapshot !== '' && currentText.includes(proposal.targetTextSnapshot)) {
		// Rule hasn't moved. Zero-cost no-op — leave status as 'proposed', no DB write, no LLM call.
		return { kind: 'noOp' };
	}

	let response: Anthropic.Message;
	try {
		response = await callReconciliationModel(proposal, currentText, anthropic);
	} catch {
		// The call itself never completed — no usage was ever billed, nothing to log. One flaky
		// call must not abort reconciliation of every other unrelated proposal in this batch.
		return { kind: 'errored', usageLogged: false };
	}

	// The call succeeded and real tokens were spent, regardless of whether the response content
	// below parses cleanly — log the spend before attempting to interpret the verdict.
	await logAuditRunCall(auditRunId, response.usage, prisma);

	let addressed: boolean;
	try {
		addressed = extractAddressedVerdict(response);
	} catch {
		return { kind: 'errored', usageLogged: true };
	}

	if (addressed) {
		await prisma.ruleProposal.update({
			where: { id: proposal.id },
			data: { status: RuleProposalStatus.resolved },
		});
		return { kind: 'resolved' };
	}

	// Wording changed but didn't fix the underlying gap — leave status 'proposed'.
	return { kind: 'stillProposed' };
}

export async function createAuditRun(deps: LedgerDeps = {}): Promise<AuditRun> {
	const prisma = deps.prisma ?? prismaClient;
	return prisma.auditRun.create({ data: {} });
}

// Server-startup entrypoint: null means the free fast path (zero outstanding proposals — one
// COUNT query, no AuditRun created, no LLM calls possible). Only a non-empty ledger creates a run,
// and even then ledger.ts only spends Haiku tokens on proposals whose flagged wording moved.
export async function runStartupReconciliation(
	deps: LedgerDeps = {},
): Promise<ReconciliationSummary | null> {
	const prisma = deps.prisma ?? prismaClient;
	const outstanding = await prisma.ruleProposal.count({
		where: { status: RuleProposalStatus.proposed },
	});
	if (outstanding === 0) {
		return null;
	}
	const auditRun = await createAuditRun(deps);
	try {
		return await reconcileProposals(auditRun.id, deps);
	} finally {
		await prisma.auditRun.update({
			where: { id: auditRun.id },
			data: { completedAt: new Date() },
		});
	}
}

export async function reconcileProposals(
	auditRunId: string,
	deps: LedgerDeps = {},
): Promise<ReconciliationSummary> {
	const prisma = deps.prisma ?? prismaClient;
	const anthropic = deps.anthropic ?? anthropicClient;

	const proposals = await prisma.ruleProposal.findMany({
		where: { status: RuleProposalStatus.proposed },
	});

	// Sequential, not Promise.all: this is an infrequent, human-triggered pass, not a hot path,
	// and sequential processing avoids SQLite write contention for no real throughput cost. Each
	// proposal is independent (no shared cache key like activation.ts's rulebook hash), so there's
	// no in-flight-Map dedup here either — see the design notes in the plan for why that pattern
	// doesn't transfer to a list of independent rows.
	const outcomes: ReconciliationOutcome[] = [];
	for (const proposal of proposals) {
		outcomes.push(await reconcileOneProposal(proposal, auditRunId, prisma, anthropic));
	}

	const summary: ReconciliationSummary = {
		totalProposed: proposals.length,
		noOp: 0,
		resolved: 0,
		stillProposed: 0,
		needsConfirm: 0,
		errored: 0,
		haikuCallsMade: 0,
	};
	for (const outcome of outcomes) {
		summary[outcome.kind]++;
		// Only count calls that actually completed and were billed — resolved/stillProposed are
		// only reachable after a successful, logged call; an errored outcome is only billed if
		// usageLogged is true (a network/call failure never returned a response to bill for).
		if (
			outcome.kind === 'resolved' ||
			outcome.kind === 'stillProposed' ||
			(outcome.kind === 'errored' && outcome.usageLogged)
		) {
			summary.haikuCallsMade++;
		}
	}
	return summary;
}
