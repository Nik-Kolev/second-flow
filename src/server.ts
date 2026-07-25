import './env.js';
import path from 'node:path';
import express from 'express';
import { runStartupReconciliation } from './analysis/index.js';
import dashboardRouter from './routes/dashboard.js';

const app = express();
const PORT = process.env.PORT ?? 3000;

// import.meta.dirname is <repo>/src under `tsx watch src/server.ts` and <repo>/dist under
// `node dist/server.js` — both sit one level under the repo root, so this resolves to
// <repo>/public identically in dev and prod with no NODE_ENV branching.
const publicDir = path.join(import.meta.dirname, '..', 'public');
app.use(express.static(publicDir));
app.use(express.json());
app.use('/api', dashboardRouter);

app.listen(PORT, () => {
	console.log(`listening on port ${PORT}`);
	// Startup is the moment outstanding proposals are about to be displayed, so they get checked
	// against the current rulebook files here. Fire-and-forget on purpose: the non-empty path makes
	// network Haiku calls, and serving the dashboard must never wait on the Anthropic API.
	runStartupReconciliation()
		.then((summary) => {
			if (summary === null) {
				console.log('reconcile: no outstanding proposals, skipping');
			} else {
				console.log('reconcile:', summary);
			}
		})
		.catch((error: unknown) => {
			console.error('reconcile failed:', error);
		});
});
