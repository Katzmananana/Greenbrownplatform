# Handoff — Cursor / coding agents

## What this repo is

`green-brown-platform` is the Akshi (Green/Brown) Code Factory platform. Spec v1.1: autonomous agentic CI/CD with human checkpoints CP1/CP2/CP3. **This milestone is infra + gates only** — do not build Planner, coding-agent, MCP tool list, Auth.js, or the full Next.js admin unless a later brief says so.

Package map:

| Path | Name | Now |
|---|---|---|
| `apps/gateway` | `@gb/gateway` | Express: `GET /health`, `POST /mcp` stub, credit hard-stop middleware |
| `apps/orchestrator` | `@gb/orchestrator` | Health + `POST /internal/fix-loop/next` stub |
| `apps/web` | `@gb/web` | Admin health page stub |
| `apps/worker` | `@gb/worker` | BullMQ `jobs` consumer stub (no-ops without `REDIS_URL`) |
| `packages/shared` | `@gb/shared` | `Run`, `GateResult`, `CreditLedgerEntry`, `OrgConfig` |
| `packages/credits` | `@gb/credits` | Caps, ledger, 80% alert, `CreditHardStopError` |
| `packages/gates` | `@gb/gates` | §7 gate list + `decideFixLoop` |
| `db/migrations/001_init.sql` | — | `org_config`, `credit_ledger`, `runs`, `approvals`, `deployments` |
| `.github/workflows/ci.yml` | — | All §7 gates, all blocking |
| `.github/workflows/promote.yml` | — | CP3 `environment: production` + rollback-on-health-failure |

## Railway (lab — Hobby, 2026-11-06)

- Project: `green-brown-platform` / `aab01577-7b18-4462-a98a-e63fd5257a39`
- Env `lab`: `e99cabae-42d5-46b9-a5a5-929f030e066a`
- Plan: **Hobby** (workspace); soft $25 / hard $40 usage limits
- Services (all Online):
  - `Postgres` `672414c9-a8d6-464d-b38b-288f140c8d40` — SUCCESS
  - `Redis` `ed48d097-2544-4cd1-a60c-9a5fe69a3dd1`
  - `gateway` `8225942d-b2cc-4118-baec-91ffcb408695` — https://gateway-lab-df41.up.railway.app `/health` → 200
  - `orchestrator` `3ce82d64-6d6b-4e42-a810-e9d025c05759`
  - `web` `e439abf5-4b73-48ef-a0f1-7bf07f72f9f0` — https://web-lab-2632.up.railway.app `/health` → 200
  - `worker` `70e8153e-aa76-405b-b4b3-57c19f2f6554`
- GitHub source on all four apps: `Katzmananana/Greenbrownplatform@main`
- Build: `pnpm install && pnpm -r build`; start via `pnpm --filter @gb/<svc> start`; health `/health`
- Vars on apps: `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `REDIS_URL=${{Redis.REDIS_URL}}`, `NODE_ENV=production`
- Orphan unattached volume (delete when approved): `postgres-volume` `5cac82cd-1b6f-44e1-967b-a5573b6eea22`

Tear-down = delete that Railway project.

## Next steps (in order)

1. ~~Hobby unlock~~ **done**
2. ~~Connect Railway sources + build~~ **done** (health 200 on gateway/web)
3. ~~Apply `db/migrations/001_init.sql`~~ **done** (tables: approvals, credit_ledger, deployments, llm_usage, org_config, runs) via migrate-init then slept
4. ~~Set secrets~~ **partial**: `CURSOR_API_KEY` + `GB_CURSOR_API_KEY` shared in lab and referenced on gateway/orchestrator/worker (`${{shared.*}}`, next deploy picks them up). Grok/Anthropic deferred (Avner will use Claude Code credits for coding). Later: `GB_JWT_SIGNING_KEY`, `GB_RAILWAY_TOKEN`, GitHub App credentials
5. ~~Configure GitHub~~ **done** (2026-11-06):
   - Branch protection on `main` (classic): require PR + require status checks; add `gates-required` after first CI run if it was missing from the search.
   - Environment `Production` with required reviewer Katzmananana; admin bypass off.
6. Next: Claude Code against this repo (Avner has credits) and/or approve bootstrap + product work (MCP tools, orchestrator state machine, coding agent).

## Local verification

```bash
pnpm install && pnpm -r build
pnpm --filter @gb/credits test
pnpm --filter @gb/gateway start   # http://127.0.0.1:3000/health
```
