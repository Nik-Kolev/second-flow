import { AuditedSessionStatus } from '../generated/prisma/index.js';
import prismaClient from '../lib/prisma.js';
import type { FindingsDeps } from './findings.js';

export type RecurrenceMarker =
	| { kind: 'recurred'; laterAuditCount: number; recurredInCount: number }
	| { kind: 'notSeenSince'; laterAuditCount: number };

// Provable-only markers, never an unprovable "fixed" — only completed later audits count, same-transcript re-audits are excluded, and null-ruleRef notes get no marker; proposals use RuleProposal.status instead.
export async function getNoteRecurrenceForSession(
	auditedSessionId: string,
	deps: FindingsDeps = {},
): Promise<Record<string, RecurrenceMarker>> {
	const prisma = deps.prisma ?? prismaClient;
	const session = await prisma.auditedSession.findUniqueOrThrow({
		where: { id: auditedSessionId },
	});
	const notes = await prisma.analysisNote.findMany({ where: { auditedSessionId } });
	const ruleRefs = [
		...new Set(
			notes
				.map((note) => note.ruleRef)
				.filter((ruleRef): ruleRef is string => ruleRef !== null),
		),
	];
	if (ruleRefs.length === 0) {
		return {};
	}

	// No project scoping — a global CLAUDE.md ref matches across projects naturally; per-project paths only ever match themselves.
	const laterAudits = await prisma.auditedSession.findMany({
		where: {
			status: AuditedSessionStatus.completed,
			createdAt: { gt: session.createdAt },
			transcriptSessionId: { not: session.transcriptSessionId },
		},
		select: { id: true },
	});
	const laterAuditCount = laterAudits.length;
	const laterAuditIds = laterAudits.map((audit) => audit.id);

	const result: Record<string, RecurrenceMarker> = {};
	if (laterAuditCount === 0) {
		for (const ruleRef of ruleRefs) {
			result[ruleRef] = { kind: 'notSeenSince', laterAuditCount: 0 };
		}
		return result;
	}

	// One query for every ruleRef instead of one per ruleRef, then group in JS.
	const laterNotes = await prisma.analysisNote.findMany({
		where: { ruleRef: { in: ruleRefs }, auditedSessionId: { in: laterAuditIds } },
		select: { ruleRef: true, auditedSessionId: true },
	});
	const recurredSessionIdsByRuleRef = new Map<string, Set<string>>();
	for (const note of laterNotes) {
		if (note.ruleRef === null) {
			continue;
		}
		const sessionIds = recurredSessionIdsByRuleRef.get(note.ruleRef) ?? new Set<string>();
		sessionIds.add(note.auditedSessionId);
		recurredSessionIdsByRuleRef.set(note.ruleRef, sessionIds);
	}

	for (const ruleRef of ruleRefs) {
		const recurredInCount = recurredSessionIdsByRuleRef.get(ruleRef)?.size ?? 0;
		result[ruleRef] =
			recurredInCount > 0
				? { kind: 'recurred', laterAuditCount, recurredInCount }
				: { kind: 'notSeenSince', laterAuditCount };
	}
	return result;
}
