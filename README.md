# second-flow

A local tool that reads your own Claude Code session transcripts and audits them, as an independent external observer, against your live rulebook (whatever your setup actually loads). Reports where the agent skipped or half-arsed a rule, proposes tightened wording when the wording is what failed, and coaches the prompts that led there.

Runs only on your own machine, billed on your own Anthropic API key — never touches your Claude Code subscription's limits.

## Status

Core step 1 (scaffold) done: Express + TypeScript + Prisma/SQLite base, no domain logic or routes yet. See the Core steps in the project plan for what's next.

## Setup

```bash
npm install
cp .env.example .env   # then fill in ANTHROPIC_API_KEY
npx prisma migrate dev --name init
npm run dev
```

## Scripts

- `npm run dev` — start the server (`tsx watch`)
- `npm run build` — compile to `dist/`
- `npm start` — run the compiled build
- `npm run lint` / `npm run format`
