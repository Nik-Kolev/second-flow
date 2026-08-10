export interface ModelPricing {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

// Per-MTok USD rates verified against Anthropic's pricing table 2026-07-25 — Sonnet's introductory rate expires 2026-08-31 (then 3.00/15.00/0.30/3.75); must cover every JUDGMENT_MODELS entry or spend silently reads $0.
export const PRICING_PER_MTOK: Record<string, ModelPricing> = {
	'claude-haiku-4-5': { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
	'claude-sonnet-5': { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 2.5 },
	'claude-opus-5': { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
	'claude-fable-5': { input: 10.0, output: 50.0, cacheRead: 1.0, cacheWrite: 12.5 },
};

export interface CallCostInput {
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
}

export function computeCallCostUsd(call: CallCostInput): number {
	const pricing = PRICING_PER_MTOK[call.model];
	if (!pricing) {
		// Defensive only — AuditRunCall.model is either the hardcoded HAIKU_MODEL constant or a JUDGMENT_MODELS entry, which is required to have a pricing row above.
		console.warn(`No pricing entry for model "${call.model}" — treating its cost as $0`);
		return 0;
	}
	return (
		(call.inputTokens * pricing.input +
			call.outputTokens * pricing.output +
			call.cacheReadTokens * pricing.cacheRead +
			call.cacheCreationTokens * pricing.cacheWrite) /
		1_000_000
	);
}

export function computeTotalSpendUsd(calls: CallCostInput[]): number {
	return calls.reduce((total, call) => total + computeCallCostUsd(call), 0);
}
