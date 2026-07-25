import { AuditedSessionStatus } from '../generated/prisma/index.js';
import prismaClient from '../lib/prisma.js';
import type { FindingsDeps } from './findings.js';

export type RecurrenceMarker =
	| { kind: 'recurred'; laterAuditCount: number; recurredInCount: number }
	| { kind: 'notSeenSince'; laterAuditCount: number };

// Provable-only marker semantics: "recurred" and "not seen since N later audits" are both
// statements about what later judgment passes actually reported — never an unprovable "fixed".
// Three deliberate exclusions keep the claims honest:
// - only status-completed later audits count (wavedThrough/errored/skippedCeiling never ran a
//   judgment pass, so their silence proves nothing),
// - later audits of the same transcript are excluded (the same session re-analyzed showing the
//   same problem is not a new occurrence of the mistake),
// - notes with a null ruleRef (pre-field legacy rows) get no marker at all.
// Proposals need no util here — their marker is RuleProposal.status, set by reconciliation.
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

	// No explicit project scoping: a ruleRef is a file source string, so a global CLAUDE.md ref
	// matches across projects naturally while per-project file paths only ever match themselves.
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
	for (const ruleRef of ruleRefs) {
		if (laterAuditCount === 0) {
			result[ruleRef] = { kind: 'notSeenSince', laterAuditCount: 0 };
			continue;
		}
		const laterNotes = await prisma.analysisNote.findMany({
			where: { ruleRef, auditedSessionId: { in: laterAuditIds } },
			select: { auditedSessionId: true },
		});
		const recurredInCount = new Set(laterNotes.map((note) => note.auditedSessionId)).size;
		result[ruleRef] =
			recurredInCount > 0
				? { kind: 'recurred', laterAuditCount, recurredInCount }
				: { kind: 'notSeenSince', laterAuditCount };
	}
	return result;
}
