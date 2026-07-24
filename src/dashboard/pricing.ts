export interface ModelPricing {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

// Per-million-token USD rates, verified against the Anthropic API pricing table on 2026-07-24 —
// not training-data recall. Sonnet's figures are the introductory rate, active through
// 2026-08-31; after that, update to input 3.00 / output 15.00 / cacheRead 0.30 / cacheWrite 3.75
// (the standard rate). Cache-write uses the 1.25x (5-minute TTL) multiplier, not 2x (1-hour) —
// `grep -rn cache_control src/` returns no matches, so every call in this codebase runs at the
// API's default TTL.
export const PRICING_PER_MTOK: Record<string, ModelPricing> = {
	'claude-haiku-4-5': { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
	'claude-sonnet-5': { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 2.5 },
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
		// Defensive only — the only two model strings that ever reach AuditRunCall.model are the
		// hardcoded HAIKU_MODEL/SONNET_MODEL constants in ledger.ts/judgment.ts.
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
