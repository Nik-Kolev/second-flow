import readline from 'node:readline/promises';
import '../env.js';
import prismaClient from '../lib/prisma.js';
import { runActivatedCheckers } from '../lint/index.js';
import { parseSession } from '../parser/index.js';
import { resolveRulebook } from '../rulebook/index.js';
import { computeSessionStats } from '../stats/index.js';
import { createAuditRun } from './ledger.js';
import { runJudgmentPipelineForSession } from './pipeline.js';

// Not named inspect.ts — every existing inspect.ts is read-only by convention; this one spends
// real Sonnet tokens and writes to the DB. Run manually via tsx, same as the inspect.ts files —
// there is no HTTP route to drive this yet (that's step 8).
async function main(): Promise<void> {
	const [slug, sessionId] = process.argv.slice(2);
	if (!slug) {
		console.log('Usage: tsx src/analysis/judge-session.ts <projectSlug> [sessionId]');
		process.exitCode = 1;
		return;
	}

	const session = await parseSession(slug, sessionId);
	const stats = computeSessionStats(session);
	const rulebook = await resolveRulebook(session.attachments, session.meta, session.timeline);
	const lintFindings = await runActivatedCheckers(session.timeline, rulebook);

	const auditRun = await createAuditRun();

	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	const confirmBatch = async (): Promise<boolean> => {
		const answer = await rl.question(
			'Session triggered Pass 2 (1 Sonnet call). Proceed? [y/N] ',
		);
		return /^y(es)?$/i.test(answer.trim());
	};

	try {
		const outcome = await runJudgmentPipelineForSession(
			{ session, stats, lintFindings, rulebook },
			auditRun.id,
			confirmBatch,
		);
		console.log(outcome);
	} finally {
		rl.close();
		await prismaClient.auditRun.update({
			where: { id: auditRun.id },
			data: { completedAt: new Date() },
		});
	}
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
