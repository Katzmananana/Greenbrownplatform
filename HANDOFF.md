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

## Railway (already created)

- Project: `green-brown-platform` / `aab01577-7b18-4462-a98a-e63fd5257a39`
- Env `lab`: `e99cabae-42d5-46b9-a5a5-929f030e066a`
- Present: `gateway`, Redis
- Blocked on Free until Hobby: Postgres, orchestrator, web, worker

Tear-down = delete that Railway project.

## Next steps (in order)

1. **Hobby unlock** on the Railway project (~$5/month) so Postgres + the remaining services can be created.
2. **Connect Railway sources** for `gateway`, `orchestrator`, `web`, and `worker` to this GitHub repo (root directory, Node 22). Build: `pnpm install && pnpm -r build`. Start commands are in `infra/railway/README.md` and `infra/railway/railway.toml`. Health path: `/health`.
3. **Set secrets** as Railway shared/service variables (never commit them):
   - `GROK_API_KEY` (also copy into `GB_XAI_API_KEY`)
   - `ANTHROPIC_API_KEY` (also copy into `GB_ANTHROPIC_API_KEY`)
   - `CURSOR_API_KEY` (also copy into `GB_CURSOR_API_KEY`)
   - Later: `GB_JWT_SIGNING_KEY`, `GB_RAILWAY_TOKEN`, GitHub App credentials
4. Apply `db/migrations/001_init.sql` once Postgres exists (`DATABASE_URL`).
5. Configure GitHub:
   - Branch protection on `main`: required checks = `lint`, `typecheck`, `unit`, `functional`, `e2e`, `reviewer`, `acceptance`, `sast`, `load`, `load-staging`, `fix-loop` (and `gates-required`).
   - Environment `production` with required reviewers (this is CP3 for promote.yml).
   - Optional repo variable `GATE_STUB=0` when real reviewer/acceptance/staging should fail-closed.
6. Only then start product work (MCP tools, orchestrator state machine, coding agent).

## Local verification

```bash
pnpm install && pnpm -r build
pnpm --filter @gb/credits test
pnpm --filter @gb/gateway start   # http://127.0.0.1:3000/health
```
