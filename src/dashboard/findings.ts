import prismaClient from '../lib/prisma.js';
import type {
	AnalysisNote,
	AnalysisNoteKind,
	RuleProposal,
	RuleProposalStatus,
} from '../generated/prisma/index.js';

export interface FindingsDeps {
	prisma?: typeof prismaClient;
}

export const PROPOSAL_STATUS_RANK: Record<RuleProposalStatus, number> = {
	proposed: 0,
	needsConfirm: 1,
	recurring: 2,
	resolved: 3,
	dismissed: 4,
};

export const NOTE_KIND_RANK: Record<AnalysisNoteKind, number> = {
	compliance: 0,
	environmentalInstruction: 1,
	promptCoaching: 2,
};

export interface ProposalGroup {
	targetRuleRef: string;
	auditedSessionId: string;
	status: RuleProposalStatus;
	occurrenceCount: number;
	representative: RuleProposal;
	allEvidence: string[];
	latestCreatedAt: Date;
}

// Groups by (auditedSessionId, targetRuleRef): a single Sonnet call can return multiple
// ruleRewriteProposals targeting the same file within one audited session (persistJudgmentFindings
// writes one row per array item, no dedup at write time) — this collapses exactly those real
// duplicates. It deliberately does NOT collapse the same targetRuleRef across different
// AuditedSession rows: a gap recurring across separate sessions/runs is a distinct occurrence
// worth seeing on its own, not noise to merge away.
export async function getRankedProposalGroups(deps: FindingsDeps = {}): Promise<ProposalGroup[]> {
	const prisma = deps.prisma ?? prismaClient;
	const proposals = await prisma.ruleProposal.findMany({ orderBy: { createdAt: 'desc' } });

	const groups = new Map<string, RuleProposal[]>();
	for (const proposal of proposals) {
		const key = `${proposal.auditedSessionId}::${proposal.targetRuleRef}`;
		const existing = groups.get(key);
		if (existing) {
			existing.push(proposal);
		} else {
			groups.set(key, [proposal]);
		}
	}

	const result: ProposalGroup[] = [];
	for (const rows of groups.values()) {
		// rows came from a createdAt-desc query, so rows[0] is the most recent in the group.
		const representative = rows[0]!;
		const status = rows.reduce(
			(worst, row) =>
				PROPOSAL_STATUS_RANK[row.status] < PROPOSAL_STATUS_RANK[worst] ? row.status : worst,
			representative.status,
		);
		result.push({
			targetRuleRef: representative.targetRuleRef,
			auditedSessionId: representative.auditedSessionId,
			status,
			occurrenceCount: rows.length,
			representative,
			allEvidence: rows.map((row) => row.evidence),
			latestCreatedAt: representative.createdAt,
		});
	}

	result.sort((a, b) => {
		const rankDiff = PROPOSAL_STATUS_RANK[a.status] - PROPOSAL_STATUS_RANK[b.status];
		if (rankDiff !== 0) {
			return rankDiff;
		}
		const countDiff = b.occurrenceCount - a.occurrenceCount;
		if (countDiff !== 0) {
			return countDiff;
		}
		return b.latestCreatedAt.getTime() - a.latestCreatedAt.getTime();
	});

	return result;
}

// Grouped by kind only, never merged — AnalysisNote has no identity field like targetRuleRef, and
// collapsing on the coarse 3-way kind would wrongly merge unrelated evidence into one misleading
// "occurrence count." Volume control for notes comes entirely from the display-side cap, not from
// server-side collapsing.
export async function getRankedNotesByKind(
	deps: FindingsDeps = {},
): Promise<Record<AnalysisNoteKind, AnalysisNote[]>> {
	const prisma = deps.prisma ?? prismaClient;
	const notes = await prisma.analysisNote.findMany({ orderBy: { createdAt: 'desc' } });

	const byKind: Record<AnalysisNoteKind, AnalysisNote[]> = {
		compliance: [],
		environmentalInstruction: [],
		promptCoaching: [],
	};
	for (const note of notes) {
		byKind[note.kind].push(note);
	}
	return byKind;
}
