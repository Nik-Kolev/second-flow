# second-flow — Project Context

A local tool that reads Claude Code session transcripts and audits them, as an independent external observer, against your live rulebook. See the private Level 2 doc for current state, project rules, and the full draft design plan pointer.

## Stack

| Layer       | Tech                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------- |
| Server      | Express 5, TypeScript (ESM, `nodenext`), `tsx` for dev                                   |
| DB          | SQLite via Prisma 7, `@prisma/adapter-libsql` (multi-file schema under `prisma/schema/`) |
| LLM         | Anthropic Messages API (Haiku + Sonnet tiers), key from `.env`                           |
| Lint/Format | ESLint flat config (`eslint.config.js`) + Prettier                                       |

## Structure

- `src/server.ts` — Express entry point
- `src/lib/prisma.ts` — Prisma client singleton
- `src/env.ts` — loads `.env` via `process.loadEnvFile()` (no `dotenv` dependency — Node 20.12+ stdlib)
- `src/parser/` — reads Claude Code's own session JSONL transcripts (`~/.claude/projects/<slug>/`, path overridable via `CLAUDE_PROJECTS_DIR`) and splits them into a conversation timeline, environmental-context records, and noise; no DB writes, pure in-memory parsing. `src/parser/__tests__/` — `node:test` (Node's built-in runner, no new dependency), run via `npm test`.
- `src/rulebook/` — given a parsed session's `attachments`/`meta.cwd`, discovers the rulebook that actually governed it: global `~/.claude/CLAUDE.md`, one project-root `CLAUDE.md` (no `@`-import recursion or nested subtree discovery yet — deferred, neither appears in real transcripts so far), a `SessionStart` hook's injected docs (if the user runs one), and environmental instructions (MCP/skill/output-style attachments, with MCP add/remove deltas netted to the currently-active set). Tags every block by source layer (`managed`/`user`/`project`/`environmental`) — no merge/precedence logic. No DB writes. `src/rulebook/__tests__/` — same `node:test` convention, run via `npm test`.
- `src/stats/` — given a parsed session's `timeline`, computes structural facts as evidence for later findings: agent/subagent usage (with repeat-invocation candidates), context-budget consumption per turn, cache-read ratio with unexplained-drop detection (cross-referenced against `/compact` events), rate-limit hits, and git/subagent boundary candidates. Pure in-memory, no DB writes. `src/stats/__tests__/` — same `node:test` convention, run via `npm test`.
- `src/lint/` — deterministic rule-adherence checkers (Layer 1 of the two-layer audit): one function per rule-shape (`commit-gating`, `format-before-commit`, `shell-command-label`, `boundary-compact`), each scanning a parsed session's `timeline` for a mechanically-checkable violation, returning `LintFinding[]`. An activation map (one cached Haiku call per distinct rulebook, keyed by a content hash in the `CheckerActivation` table) classifies which rule-shapes a given rulebook actually contains, so `runActivatedCheckers` only runs checkers whose rule is actually present. `src/lint/__tests__/` — same `node:test` convention, run via `npm test`.
- `src/analysis/` — the proposal ledger and Layer 2 (judgment pass). `ledger.ts` is the DB source of truth (`RuleProposal`/`AnalysisNote`/`AuditRun`/`AuditRunCall`) plus `runStartupReconciliation`, wired into server startup, which checks outstanding proposals against the _current_ rulebook (free substring check, escalating to one Haiku call only when the flagged wording has moved; free COUNT fast path when the ledger is empty). The judgment pipeline (`gate.ts`, `evidence-window.ts`, `judgment.ts`, `settings.ts`, `ceiling.ts`, `pipeline.ts`) decides whether a session is worth a judgment call (Pass 1: free heuristics over lint findings, stats, and pushback/clarifying-question detection), builds a cost-bounded evidence window around the trigger points, and sends it to the configured judgment model for evidence-grounded findings (rule-rewrite proposals, plus compliance/environmental-instruction-ignored/prompt-coaching notes, each carrying a `ruleRef` — a rulebook file source or `"general"`, invalid values coerced to `"general"` rather than dropped). The judgment model is swappable via `AuditSettings.judgmentModel` (Sonnet 5 default / Opus 5 / Fable 5 — allowlist in `settings.ts`; every entry must have a pricing row in `src/dashboard/pricing.ts`); Haiku stays fixed for activation/reconciliation classification. Settings live in `settings.ts`, not `ceiling.ts`, because both `judgment.ts` and `ceiling.ts` need them and `ceiling.ts` already imports from `judgment.ts` (circular otherwise); `ceiling.ts` re-exports them. `judge-session.ts` is a manual CLI entrypoint (`tsx src/analysis/judge-session.ts <projectSlug> [sessionId]`); the HTTP audit route is the primary driver. `src/analysis/__tests__/` — same `node:test` convention (some suites use a temp SQLite DB via `prisma db push`, matching the project's no-mocking convention), run via `npm test`.
- `src/dashboard/` — read-model helpers over the ledger: `pricing.ts` (per-MTok rates, verified against the live pricing page — never from memory), `findings.ts` (ranked proposal groups / notes by kind), `overview.ts` (spend + ceiling strip), `recurrence.ts` (provable-only note markers: `recurred` / `not seen since N later audits`, counting only status-`completed` later audits of _different_ transcripts — never an unprovable "fixed"). `src/dashboard/__tests__/` — same conventions.
- `src/routes/` — the HTTP surface, mounted under `/api` by `server.ts`. Router factories (`createSessionsRouter`/`createDashboardRouter`) take a deps object so route tests can inject a temp DB, fake Anthropic client, and fixture rulebook/projects dirs (tests spin up a real Express server on port 0 and use global `fetch` — no supertest dependency). `sessions.ts`: projects list, per-project session list joined with audit history (+`changedSinceAudit` from stored file size/mtime), free preview (gate + `count_tokens` estimate priced for the selected model), audit POST (409 dedup unless `force: true`; waved-through sessions persist a `wavedThrough` row; the POST itself is the spend confirmation — no `confirmJudgmentBatch` inside), stored-findings GET with recurrence markers. `dashboard.ts`: dashboard payload (legacy `overview`/`notesByKind` keys stay until the UI rebuild lands) + `PUT /dashboard/settings` (judgment model, allowlist-validated) + `PUT /dashboard/ceiling`.
- `prisma/schema/` — one file per domain; `base.prisma` holds generator + datasource only
- `prisma.config.ts` — datasource URL and migrations path (Prisma 7 moved these out of the schema file)

## Commands

- `npm run dev` — start the server (`tsx watch`)
- `npm run build` — compile to `dist/`
- `npm start` — run the compiled build
- `npm run lint` / `npm run format`
- `npm test` — run the parser, rulebook, stats, lint, and analysis test suites
- `npx prisma migrate dev --name <name>` — apply a schema change
- `npx prisma studio` — browse the SQLite DB

## Setup

Copy `.env.example` to `.env` and fill in `ANTHROPIC_API_KEY`.
