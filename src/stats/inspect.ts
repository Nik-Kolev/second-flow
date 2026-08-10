import '../env.js';
import { parseSession } from '../parser/index.js';
import { computeSessionStats } from './index.js';

async function main(): Promise<void> {
	const [slug, sessionId] = process.argv.slice(2);
	if (!slug) {
		console.log('Usage: tsx src/stats/inspect.ts <projectSlug> [sessionId]');
		process.exitCode = 1;
		return;
	}

	const session = await parseSession(slug, sessionId);
	const stats = computeSessionStats(session);

	console.log(`Session: ${stats.sessionId}  Project: ${stats.projectSlug}`);
	console.log();

	console.log(`Agent invocations: ${stats.agents.invocations.length}`);
	for (const summary of stats.agents.byType) {
		console.log(
			`  - ${summary.subagentType ?? '(unknown type)'}: ${summary.invocationCount}x` +
				(summary.isRepeatCandidate ? '  [repeat candidate]' : ''),
		);
	}
	for (const invocation of stats.agents.invocations) {
		console.log(
			`    ${invocation.toolUseId} type=${invocation.subagentType ?? '?'} model=${invocation.subagentModel ?? '?'} status=${invocation.resultStatus ?? '?'} tokens=${invocation.usage?.subagentTokens ?? '?'}`,
		);
	}
	console.log();

	console.log(`Context budget points: ${stats.contextBudget.length}`);
	const lastPoint = stats.contextBudget.at(-1);
	if (lastPoint) {
		console.log(
			`  last turn: model=${lastPoint.model} contextTokens=${lastPoint.contextTokens} percentConsumed=${lastPoint.percentConsumed ?? '(no window size known)'}`,
		);
	}
	console.log();

	console.log(`Cache ratio points: ${stats.cache.series.length}`);
	console.log(`Unexplained cache drops: ${stats.cache.unexplainedDrops.length}`);
	for (const drop of stats.cache.unexplainedDrops) {
		console.log(
			`  turn ${drop.fromTurnIndex} -> ${drop.toTurnIndex}: ${drop.fromRatio} -> ${drop.toRatio}`,
		);
	}
	console.log();

	console.log(`Rate-limit hits: ${stats.rateLimitHits.length}`);
	for (const hit of stats.rateLimitHits) {
		console.log(
			`  turn ${hit.turnIndex} at ${hit.timestamp} (status ${hit.apiErrorStatus ?? '?'})`,
		);
	}
	console.log();

	console.log(`Boundary candidates: ${stats.boundaryCandidates.length}`);
	for (const candidate of stats.boundaryCandidates) {
		console.log(
			`  [${candidate.kind}] ${candidate.timestamp}${candidate.detail ? ` — ${candidate.detail}` : ''}`,
		);
	}
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
