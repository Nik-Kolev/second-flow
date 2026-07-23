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
- `prisma/schema/` — one file per domain; `base.prisma` holds generator + datasource only
- `prisma.config.ts` — datasource URL and migrations path (Prisma 7 moved these out of the schema file)

## Commands

- `npm run dev` — start the server (`tsx watch`)
- `npm run build` — compile to `dist/`
- `npm start` — run the compiled build
- `npm run lint` / `npm run format`
- `npx prisma migrate dev --name <name>` — apply a schema change
- `npx prisma studio` — browse the SQLite DB

## Setup

Copy `.env.example` to `.env` and fill in `ANTHROPIC_API_KEY`.
