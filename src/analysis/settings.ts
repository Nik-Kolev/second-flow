import prismaClient from '../lib/prisma.js';
import type { AuditSettings } from '../generated/prisma/index.js';

export const DEFAULT_MAX_SONNET_CALLS_PER_RUN = 10;

// Swappable judgment model allowlist (Layer 2 only; Haiku stays fixed elsewhere) — every entry needs a pricing row in src/dashboard/pricing.ts or its spend silently reads as $0.
export const JUDGMENT_MODELS = ['claude-sonnet-5', 'claude-opus-5', 'claude-fable-5'] as const;
export type JudgmentModel = (typeof JUDGMENT_MODELS)[number];

export interface SettingsDeps {
	prisma?: typeof prismaClient;
}

export function isJudgmentModel(value: unknown): value is JudgmentModel {
	return typeof value === 'string' && (JUDGMENT_MODELS as readonly string[]).includes(value);
}

// Lazily created singleton, seeded from DEFAULT_MAX_SONNET_CALLS_PER_RUN — persisted so the dashboard's settings controls can change it with no restart.
export async function getAuditSettings(deps: SettingsDeps = {}): Promise<AuditSettings> {
	const prisma = deps.prisma ?? prismaClient;
	const existing = await prisma.auditSettings.findFirst();
	if (existing) {
		return existing;
	}
	return prisma.auditSettings.create({
		data: { maxSonnetCallsPerRun: DEFAULT_MAX_SONNET_CALLS_PER_RUN },
	});
}

export async function updateMaxSonnetCallsPerRun(
	value: number,
	deps: SettingsDeps = {},
): Promise<AuditSettings> {
	const prisma = deps.prisma ?? prismaClient;
	const settings = await getAuditSettings(deps);
	return prisma.auditSettings.update({
		where: { id: settings.id },
		data: { maxSonnetCallsPerRun: value },
	});
}

export async function updateJudgmentModel(
	model: JudgmentModel,
	deps: SettingsDeps = {},
): Promise<AuditSettings> {
	const prisma = deps.prisma ?? prismaClient;
	const settings = await getAuditSettings(deps);
	return prisma.auditSettings.update({
		where: { id: settings.id },
		data: { judgmentModel: model },
	});
}
