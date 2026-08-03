// Best-effort secret scrubbing (small pattern set, not a guarantee) — transcripts can contain pasted credentials.

interface SecretPattern {
	pattern: RegExp;
	replace: string;
}

const SECRET_PATTERNS: SecretPattern[] = [
	{ pattern: /sk-ant-[A-Za-z0-9_-]{10,}/g, replace: '[REDACTED:anthropic-key]' },
	{ pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, replace: 'Bearer [REDACTED]' },
	{
		pattern:
			/\b([A-Z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|ACCESS[_-]?KEY|PRIVATE[_-]?KEY)[A-Z0-9_]*)\s*=\s*\S+/gi,
		replace: '$1=[REDACTED]',
	},
	{ pattern: /^([A-Z][A-Z0-9_]{1,})=([A-Za-z0-9+/_.-]{16,})$/gm, replace: '$1=[REDACTED]' },
];

export function scrubText(input: string): string {
	return SECRET_PATTERNS.reduce(
		(text, { pattern, replace }) => text.replace(pattern, replace),
		input,
	);
}

export function scrubDeep<T>(value: T): T {
	if (typeof value === 'string') {
		return scrubText(value) as unknown as T;
	}
	if (Array.isArray(value)) {
		return value.map((item) => scrubDeep(item)) as unknown as T;
	}
	if (value !== null && typeof value === 'object') {
		const result: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
			result[key] = scrubDeep(val);
		}
		return result as T;
	}
	return value;
}
