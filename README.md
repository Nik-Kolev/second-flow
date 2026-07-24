# second-flow

A local tool that reads your own Claude Code session transcripts and audits them, as an independent external observer, against your live rulebook (whatever your setup actually loads). Reports where the agent skipped or half-arsed a rule, proposes tightened wording when the wording is what failed, and coaches the prompts that led there.

Runs only on your own machine, billed on your own Anthropic API key — never touches your Claude Code subscription's limits.

## Status

Core step 2 (transcript parser) done: reads Claude Code's own session JSONL files and splits them into a conversation timeline, environmental-context records (hooks, skills, MCP instructions, output style), and noise. Core step 3 (rulebook resolver) done: given a parsed session, discovers what actually governed it — global/project `CLAUDE.md`, a `SessionStart` hook's injected docs, and environmental instructions (MCP/skill/output-style) — and tags each block by source layer, with no merge/precedence logic. Core step 4 (stats layer) done: given a parsed session, computes structural evidence facts — agent/subagent usage, context-budget consumption, cache-read ratio with unexplained-drop detection, rate-limit hits, and git/subagent boundary candidates — pure in-memory, no DB writes. Core step 5 (rule-adherence lint) done: a deterministic checker library plus an activation map (one cached Haiku call per rulebook) that runs only the checkers whose rule-shape is actually present. Core step 6 (proposal store + reconciliation) done: `RuleProposal`/`AnalysisNote`/`AuditRun`/`AuditRunCall` persist findings and the tool's own spend, and a startup reconciliation pass detects when a flagged rule has already been fixed. Core step 7 (Sonnet judgment pass) done: a free heuristic gate decides whether a session is worth a Sonnet call, then an evidence-grounded pass proposes rule rewrites, compliance notes, and prompt-coaching notes, cost-bounded and ceiling-enforced. Still no Express routes/output surface wired up yet. See the Core steps in the project plan for what's next.

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
- `npm test` — run the parser, rulebook resolver, stats, lint, and analysis test suites (`node:test`, via `tsx`)
