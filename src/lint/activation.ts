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

// Memory blocks are session-scoped — must be excluded from both hash and prompt or the cache never hits.
function activationScopedBlocks(rulebook: RulebookResolution): RulebookResolution['blocks'] {
	return rulebook.blocks.filter((block) => block.origin !== 'memory');
}

// JSON-encoding (not a joined string) means two different block sets can't hash identically just because a block's text contains the separator.
function hashRulebook(rulebook: RulebookResolution): string {
	const blockTexts = activationScopedBlocks(rulebook).map((block) => block.text);
	const encoded = JSON.stringify(blockTexts);
	return createHash('sha256').update(encoded).digest('hex');
}

function buildPrompt(rulebook: RulebookResolution): string {
	const ruleShapes = CHECKERS.map(
		(checker) => `- ${checker.id}: ${checker.ruleShapeDescription}`,
	).join('\n');
	const rulebookText = activationScopedBlocks(rulebook)
		.map((block) => block.text)
		.join('\n\n---\n\n');
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

// Malformed input must throw, not silently disable a checker.
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

	// Log spend before parsing (tokens spent either way); auditRunId is null since activation runs outside any audit run.
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

// Check-and-set must be synchronous, pre-await — Prisma reads span awaits, so two concurrent calls can both miss the cache.
const inFlightResolutions = new Map<string, Promise<Record<string, boolean>>>();

async function resolveActivationMap(
	rulebook: RulebookResolution,
	rulebookHash: string,
	deps: ActivationDeps,
): Promise<Record<string, boolean>> {
	const prisma = deps.prisma ?? prismaClient;
	const anthropic = deps.anthropic ?? anthropicClient;

	// Row count alone can't detect a renamed checker id — every row's id must also be current.
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

	// Without this, an orphaned row keeps cacheIsComplete false forever, re-hitting Haiku every call.
	await prisma.checkerActivation.deleteMany({
		where: { rulebookHash, checkerId: { notIn: [...currentCheckerIds] } },
	});

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
