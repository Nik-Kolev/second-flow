import { Router } from 'express';
import { updateMaxSonnetCallsPerRun } from '../analysis/index.js';
import {
	getDashboardOverview,
	getRankedNotesByKind,
	getRankedProposalGroups,
} from '../dashboard/index.js';

const router = Router();

router.get('/dashboard', async (_req, res) => {
	const [overview, proposals, notesByKind] = await Promise.all([
		getDashboardOverview(),
		getRankedProposalGroups(),
		getRankedNotesByKind(),
	]);
	res.json({ overview, proposals, notesByKind });
});

// Read-only over your config everywhere else — this is the one scoped write step 8 makes, and it
// only ever touches AuditSettings, never a rulebook/CLAUDE.md file.
router.put('/dashboard/ceiling', async (req, res) => {
	const value: unknown = req.body?.maxSonnetCallsPerRun;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1000) {
		res.status(400).json({
			error: 'maxSonnetCallsPerRun must be an integer between 0 and 1000',
		});
		return;
	}
	const settings = await updateMaxSonnetCallsPerRun(value);
	res.json({ maxSonnetCallsPerRun: settings.maxSonnetCallsPerRun });
});

export default router;
