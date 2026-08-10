import '../env.js';
import { parseSession } from './index.js';
import type { ToolCallEvent } from './types.js';

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function main(): Promise<void> {
	const [slug, sessionId] = process.argv.slice(2);
	if (!slug) {
		console.log('Usage: tsx src/parser/inspect.ts <projectSlug> [sessionId]');
		process.exitCode = 1;
		return;
	}

	const session = await parseSession(slug, sessionId);

	console.log(`File: ${session.filePath}`);
	console.log(`Session: ${session.sessionId}  Project: ${session.projectSlug}`);
	console.log(
		`cwd=${session.meta.cwd ?? '?'} gitBranch=${session.meta.gitBranch ?? '?'} version=${session.meta.version ?? '?'}`,
	);
	console.log(`AI titles: ${session.meta.aiTitles.join(', ') || '(none)'}`);
	console.log();

	const timelineCounts: Record<string, number> = {};
	for (const event of session.timeline) {
		timelineCounts[event.kind] = (timelineCounts[event.kind] ?? 0) + 1;
	}
	console.log('Timeline event counts:', timelineCounts);

	console.log('Attachment counts:', {
		hookSuccess: session.attachments.hookSuccess.length,
		skillListing: session.attachments.skillListing.length,
		deferredToolsDelta: session.attachments.deferredToolsDelta.length,
		agentListingDelta: session.attachments.agentListingDelta.length,
		mcpInstructionsDelta: session.attachments.mcpInstructionsDelta.length,
		outputStyle: session.attachments.outputStyle.length,
		unknown: session.attachments.unknown.length,
	});
	if (session.attachments.unknown.length > 0) {
		console.log(
			'Unknown attachment types:',
			session.attachments.unknown.map((u) => u.attachmentType),
		);
	}

	console.log(`Noise: ${session.noise.count} total`, session.noise.byType);

	const pendingToolCalls = session.timeline.filter(
		(event): event is ToolCallEvent =>
			event.kind === 'tool-call' && event.result.kind === 'pending',
	);
	console.log(`Still-pending tool calls: ${pendingToolCalls.length}`);

	const subagentCalls = session.timeline.filter(
		(event): event is ToolCallEvent => event.kind === 'tool-call' && event.isSubagentSpawn,
	);
	console.log(`Subagent spawns: ${subagentCalls.length}`);
	for (const call of subagentCalls) {
		console.log(
			`  - ${call.toolName} (${call.isBackground ? 'background' : 'sync'}) -> ${call.result.kind}`,
		);
	}

	console.log();
	console.log('First 10 timeline events:');
	for (const event of session.timeline.slice(0, 10)) {
		console.log(truncate(JSON.stringify(event), 200));
	}
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
