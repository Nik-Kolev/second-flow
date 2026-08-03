import './env.js';
import path from 'node:path';
import express from 'express';
import { runStartupReconciliation } from './analysis/index.js';
import { createDashboardRouter } from './routes/dashboard.js';
import { createSessionsRouter } from './routes/sessions.js';

const app = express();
const PORT = process.env.PORT ?? 3000;

// import.meta.dirname is <repo>/src (tsx watch) or <repo>/dist (node) — both resolve to <repo>/public with no NODE_ENV branching.
const publicDir = path.join(import.meta.dirname, '..', 'public');
app.use(express.static(publicDir));
app.use(express.json());
app.use('/api', createDashboardRouter());
app.use('/api', createSessionsRouter());

app.listen(PORT, () => {
	console.log(`listening on port ${PORT}`);
	// Fire-and-forget — serving the dashboard must never wait on the Anthropic API that reconciliation may call.
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
