import prismaClient from '../lib/prisma.js';
import type { RuleProposal, RuleProposalStatus } from '../generated/prisma/index.js';

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

export interface ProposalGroup {
	targetRuleRef: string;
	auditedSessionId: string;
	status: RuleProposalStatus;
	occurrenceCount: number;
	representative: RuleProposal;
	allEvidence: string[];
	latestCreatedAt: Date;
}

// Groups by (auditedSessionId, targetRuleRef) — collapses real write-time duplicates within one session only; a gap recurring across separate sessions stays a distinct occurrence.
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
		const status = rows.reduce(
			(worst, row) =>
				PROPOSAL_STATUS_RANK[row.status] < PROPOSAL_STATUS_RANK[worst] ? row.status : worst,
			rows[0]!.status,
		);
		// Everything shown must come from rows of the status on the badge — otherwise a group holding one proposed and one resolved row renders the resolved proposal's wording under a "Proposed" badge, presenting an edit the user already applied as still outstanding.
		const matching = rows.filter((row) => row.status === status);
		const representative = matching[0]!;
		result.push({
			targetRuleRef: representative.targetRuleRef,
			auditedSessionId: representative.auditedSessionId,
			status,
			occurrenceCount: matching.length,
			representative,
			allEvidence: matching.map((row) => row.evidence),
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
