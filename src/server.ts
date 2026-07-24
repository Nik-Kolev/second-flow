import './env.js';
import path from 'node:path';
import express from 'express';
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
});
