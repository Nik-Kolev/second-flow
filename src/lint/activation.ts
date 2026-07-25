import { createHash } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import anthropicClient from '../lib/anthropic.js';
import prismaClient from '../lib/prisma.js';
import type { TimelineEvent } from '../parser/index.js';
import type { RulebookResolution } from '../rulebook/index.js';
import { CHECKERS } from './checkers.js';
import type { LintFinding } from './types.js';

const HAIKU_MODEL = 'claude-haiku-4-5';
const ACTIVATION_TOOL_NAME = 'report_activation';
export const ACTIVATION_PURPOSE = 'activation';

interface ActivationAnthropicClient {
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

export interface ActivationDeps {
	prisma?: typeof prismaClient;
	anthropic?: ActivationAnthropicClient;
}

// Block order from resolveRulebook (src/rulebook/index.ts) is fixed (global, then
// project, then hook, then environmental), so the same rulebook always hashes the
// same way. JSON-encoding the block texts (rather than joining them on a fixed
// separator) means two different block sets can never hash identically just
// because one block's text happens to contain the separator.
function hashRulebook(rulebook: RulebookResolution): string {
	const blockTexts = rulebook.blocks.map((block) => block.text);
	const encoded = JSON.stringify(blockTexts);
	return createHash('sha256').update(encoded).digest('hex');
}

function buildPrompt(rulebook: RulebookResolution): string {
	const ruleShapes = CHECKERS.map(
		(checker) => `- ${checker.id}: ${checker.ruleShapeDescription}`,
	).join('\n');
	const rulebookText = rulebook.blocks.map((block) => block.text).join('\n\n---\n\n');
	return [
		"Below is a user's Claude Code rulebook (CLAUDE.md and related instruction text).",
		'For each rule-shape listed below, decide whether the rulebook text actually contains a rule of',
		'that shape. A rule-shape is present only if the rulebook text states it, not because it merely',
		'seems like good practice.',
		'',
		'Rule shapes:',
		ruleShapes,
		'',
		'Rulebook text:',
		rulebookText,
	].join('\n');
}

// External-API boundary: a silently malformed response here would mean a checker
// silently stops running, the false-negative failure mode this layer exists to prevent.
function parseActivationInput(input: unknown): Record<string, boolean> {
	if (typeof input !== 'object' || input === null) {
		throw new Error('Activation classification returned a non-object tool input');
	}
	const record = input as Record<string, unknown>;
	const activationMap: Record<string, boolean> = {};
	for (const checker of CHECKERS) {
		const value = record[checker.id];
		if (typeof value !== 'boolean') {
			throw new Error(
				`Activation classification is missing a boolean for checker "${checker.id}"`,
			);
		}
		activationMap[checker.id] = value;
	}
	return activationMap;
}

async function classifyRulebook(
	rulebook: RulebookResolution,
	anthropic: ActivationAnthropicClient,
	prisma: typeof prismaClient,
): Promise<Record<string, boolean>> {
	const properties: Record<string, { type: 'boolean' }> = {};
	for (const checker of CHECKERS) {
		properties[checker.id] = { type: 'boolean' };
	}

	const response = await anthropic.messages.create({
		model: HAIKU_MODEL,
		max_tokens: 1024,
		tools: [
			{
				name: ACTIVATION_TOOL_NAME,
				description:
					'Report, for each rule-shape, whether the rulebook text actually contains a rule of that shape.',
				input_schema: {
					type: 'object',
					properties,
					required: CHECKERS.map((checker) => checker.id),
					additionalProperties: false,
				},
				strict: true,
			},
		],
		tool_choice: { type: 'tool', name: ACTIVATION_TOOL_NAME },
		messages: [{ role: 'user', content: buildPrompt(rulebook) }],
	});

	// Real tokens were spent regardless of whether the content below parses — log the spend before
	// interpreting the response, same ordering as judgment.ts/ledger.ts. auditRunId is null because
	// activation happens on first sight of a rulebook, outside any audit run.
	await prisma.auditRunCall.create({
		data: {
			auditRunId: null,
			model: HAIKU_MODEL,
			purpose: ACTIVATION_PURPOSE,
			inputTokens: response.usage.input_tokens,
			outputTokens: response.usage.output_tokens,
			cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
			cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
		},
	});

	const toolUseBlock = response.content.find(
		(block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
	);
	if (!toolUseBlock) {
		throw new Error('Activation classification call returned no tool_use block');
	}
	return parseActivationInput(toolUseBlock.input);
}

// Keyed by rulebookHash. The check-and-set on this map happens synchronously, before
// any `await` in getActivationMap — the only place JS guarantees two concurrent calls
// can't both pass the check before either has published its promise. Deduping only at
// the classify step (after each call's own DB read) doesn't work: both calls can issue
// independent findMany queries and reach the classify branch before either has claimed
// the map entry, since a Prisma query is several internal await hops, not one.
const inFlightResolutions = new Map<string, Promise<Record<string, boolean>>>();

async function resolveActivationMap(
	rulebook: RulebookResolution,
	rulebookHash: string,
	deps: ActivationDeps,
): Promise<Record<string, boolean>> {
	const prisma = deps.prisma ?? prismaClient;
	const anthropic = deps.anthropic ?? anthropicClient;

	// A count match alone isn't enough: if a checker were ever renamed, a stale row
	// under the old id could keep the count equal to CHECKERS.length while a current
	// checker's id is silently missing from the map. Every cached row's id must also
	// belong to the current checker set.
	const currentCheckerIds = new Set(CHECKERS.map((checker) => checker.id));
	const cachedRows = await prisma.checkerActivation.findMany({ where: { rulebookHash } });
	const cacheIsComplete =
		cachedRows.length === CHECKERS.length &&
		cachedRows.every((row) => currentCheckerIds.has(row.checkerId));

	if (cacheIsComplete) {
		const activationMap: Record<string, boolean> = {};
		for (const row of cachedRows) {
			activationMap[row.checkerId] = row.activated;
		}
		return activationMap;
	}

	const activationMap = await classifyRulebook(rulebook, anthropic, prisma);

	await Promise.all(
		CHECKERS.map((checker) =>
			prisma.checkerActivation.upsert({
				where: { rulebookHash_checkerId: { rulebookHash, checkerId: checker.id } },
				create: {
					rulebookHash,
					checkerId: checker.id,
					activated: activationMap[checker.id],
				},
				update: { activated: activationMap[checker.id] },
			}),
		),
	);

	return activationMap;
}

export function getActivationMap(
	rulebook: RulebookResolution,
	deps: ActivationDeps = {},
): Promise<Record<string, boolean>> {
	const rulebookHash = hashRulebook(rulebook);

	const existing = inFlightResolutions.get(rulebookHash);
	if (existing) {
		return existing;
	}

	const promise = resolveActivationMap(rulebook, rulebookHash, deps).finally(() => {
		inFlightResolutions.delete(rulebookHash);
	});
	inFlightResolutions.set(rulebookHash, promise);
	return promise;
}

export async function runActivatedCheckers(
	timeline: TimelineEvent[],
	rulebook: RulebookResolution,
	deps: ActivationDeps = {},
): Promise<LintFinding[]> {
	const activationMap = await getActivationMap(rulebook, deps);
	const findings: LintFinding[] = [];
	for (const checker of CHECKERS) {
		if (activationMap[checker.id]) {
			findings.push(...checker.check(timeline));
		}
	}
	return findings;
}
