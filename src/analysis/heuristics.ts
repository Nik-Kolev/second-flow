// Provisional — needs calibration against real friction sessions (Core step 9), not validated
// patterns. Pass 1 must stay a free heuristic (no LLM call), so a missed match here is a silent
// false negative that skips Pass 2 entirely for that turn — the project's own plan notes flag
// this exact risk and defer calibration rather than asking this step to get it right up front.

const PUSHBACK_PATTERNS: RegExp[] = [
	/\bno,?\s+that'?s\s+(not|wrong|incorrect)\b/i,
	/\bthat'?s\s+not\s+(right|what|how)\b/i,
	/\bthat'?s\s+wrong\b/i,
	/\bdon'?t\s+do\s+that\b/i,
	/\b(revert|undo)\s+(that|this|it)\b/i,
	/\bwhy\s+did\s+you\b/i,
	/\byou\s+shouldn'?t\s+have\b/i,
];

const CLARIFYING_STARTERS = /^\s*(what|why|how|which|where|who|can you|could you|do you)\b/i;

export function isUserPushback(text: string): boolean {
	return PUSHBACK_PATTERNS.some((pattern) => pattern.test(text));
}

export function isClarifyingQuestion(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.endsWith('?') && CLARIFYING_STARTERS.test(trimmed);
}
