# second-flow

A local tool that reads your own Claude Code session transcripts and audits them, as an independent external observer, against the rulebook that actually governed each session — your global and project `CLAUDE.md`, any `SessionStart` hook output, MCP/skill/output-style instructions, and whichever memory files that session really read.

It reports where the agent skipped or half-arsed a rule, proposes tightened wording when the _wording_ is what failed rather than the agent, and coaches the prompts that led there.

Runs entirely on your own machine and bills your own Anthropic API key — it never touches your Claude Code subscription's limits.

## Why it exists

A rule that gets ignored is usually not a discipline problem, it's a wording problem. But you can't spot that by rereading your own `CLAUDE.md` — you need to see, session by session, which rules were live and which of them the agent actually followed. That's what this reads out of the transcripts.

## How it works

Every audit runs the same five stages:

1. **Parse** — reads Claude Code's own session JSONL (`~/.claude/projects/<slug>/`) and splits it into a conversation timeline, environmental-context records, and noise.
2. **Resolve the rulebook** — works out what actually governed _that_ session and tags each block by source layer (`managed` / `user` / `project` / `environmental` / `memory`). Content is always re-read live from disk, so an audit judges against current wording.
3. **Collect evidence** — structural facts, computed for free: subagent usage, context-budget burn per turn, cache-read ratio with unexplained-drop detection, rate-limit hits, and git/subagent boundary candidates.
4. **Layer 1 — deterministic lint** — one checker per mechanically-checkable rule shape. An activation map (one cached Haiku call per distinct rulebook, keyed by content hash) means only checkers whose rule actually exists in your rulebook get run.
5. **Layer 2 — judgment pass** — a free heuristic gate decides whether a session is even worth a paid call. If it is, a cost-bounded evidence window is built around the trigger points and sent to the configured model for evidence-grounded findings.

### Cost control is the design constraint

The expensive stage is deliberately the last and the most gated:

- The gate in stage 5 is **free** — most sessions never reach a paid call at all.
- A `count_tokens` estimate is shown, priced for the selected model, **before** anything is spent.
- The audit runs only on explicit confirmation, and every call's real spend is recorded (`AuditRun` / `AuditRunCall`).
- A configurable ceiling caps per-run spend.
- Haiku is fixed for the cheap classification work; the judgment model is swappable (Sonnet 5 default, Opus 5, Fable 5).

### What it gives back

Rule-rewrite proposals, plus notes for compliance, ignored environmental instructions, and prompt coaching. Findings carry **provable-only** recurrence markers — `recurred`, or `not seen since N later audits` — counting only completed audits of _different_ transcripts. It never claims a rule is "fixed", because that isn't provable from transcripts.

A startup reconciliation pass re-checks outstanding proposals against the current rulebook, so a rule you've already rewritten stops being reported.

## Status

**In development, and usable end to end.** Parsing, rulebook resolution, stats, the deterministic lint layer, the proposal ledger, and the judgment pass are all implemented and tested. The HTTP API (`src/routes/`) and a dependency-free dashboard (`public/` — Sessions | Findings | Rule proposals) are wired up: you can browse projects, drill into sessions, preview an audit's cost, run it, and read the findings.

Known limits, on purpose: no `@`-import recursion or nested-subtree `CLAUDE.md` discovery yet (neither has shown up in a real transcript), and rulebook layers are tagged but not merged — there's no precedence logic. Memory and stack-rule findings are notes only, never rule-rewrite targets.

## Setup

```bash
npm install
cp .env.example .env   # then fill in ANTHROPIC_API_KEY
npx prisma migrate dev --name init
npm run dev            # dashboard + API on http://localhost:3000 (override with PORT)
```

## Scripts

- `npm run dev` — start the server (`tsx watch`)
- `npm run build` — compile to `dist/`
- `npm start` — run the compiled build
- `npm run lint` / `npm run format`
- `npm test` — full suite (`node:test` via `tsx`, no test-runner dependency)
- `npx prisma studio` — browse the SQLite DB

## Stack

| Layer    | Tech                                                                              |
| -------- | --------------------------------------------------------------------------------- |
| Server   | Express 5, TypeScript (ESM, `nodenext`), `tsx` for dev                            |
| DB       | SQLite via Prisma 7 + `@prisma/adapter-libsql`                                    |
| LLM      | Anthropic Messages API — Haiku for classification, a swappable model for judgment |
| Frontend | Vanilla HTML/CSS/JS, no build step                                                |
| Tests    | `node:test`, real temp SQLite databases rather than mocks                         |
