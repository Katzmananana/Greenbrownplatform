# Handoff — Cursor / coding agents

## What this repo is

`green-brown-platform` is the Akshi (Green/Brown) Code Factory platform. Spec v1.1: autonomous agentic CI/CD with human checkpoints CP1/CP2/CP3. **Lab milestone:** infra, gates, gateway MCP, and the orchestrator run lifecycle (stub Planner/coder/fixer jobs). Do not build the real Planner, coding-agent, Auth.js, or the full Next.js admin unless a later brief says so.

Package map:

| Path | Name | Now |
|---|---|---|
| `apps/gateway` | `@gb/gateway` | Express: `GET /health`, `POST /mcp` MCP server (`create_run`/`get_run`/`approve`, bearer auth), credit hard-stop middleware |
| `apps/orchestrator` | `@gb/orchestrator` | Run lifecycle loop (Postgres poll, BullMQ handoff, credit hard-stop, `decideFixLoop`) + health |
| `apps/web` | `@gb/web` | Admin health page stub |
| `apps/worker` | `@gb/worker` | BullMQ `jobs` consumer: `plan` / `code` / `fix` payloads, stub handlers |
| `packages/shared` | `@gb/shared` | `Run`, `GateResult`, `CreditLedgerEntry`, `OrgConfig` |
| `packages/credits` | `@gb/credits` | Caps, ledger, 80% alert, `CreditHardStopError` |
| `packages/gates` | `@gb/gates` | §7 gate list + `decideFixLoop` |
| `db/migrations/001_init.sql` | — | `org_config`, `credit_ledger`, `runs`, `approvals`, `deployments` |
| `db/migrations/002_requests.sql` | — | `requests` (free-text request for MCP `create_run`) |
| `db/migrations/003_run_phase.sql` | — | `runs.phase` + `phase_reason` for the orchestrator loop. **Apply on lab** (idempotent) |
| `db/migrations/004_safety.sql` | — | `execution_mode`, `dispatch_outbox`, `run_evidence`, dispatch ledger uniqueness. **Apply on lab before this code** |
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
6. ~~MCP milestone~~ **done** on `main` (`073948d`). `POST /mcp` speaks JSON-RPC MCP (`initialize`, `ping`, `tools/list`, `tools/call`) with tools `create_run`, `get_run`, `approve` (CP1→CP2→CP3 in order; CP3 → `succeeded`). `pg` is a gateway dependency; `/health` reports `runStore`. Lab, if a service was not redeployed after that merge: set `GB_MCP_TOKEN` (production returns 503 without it) and apply `db/migrations/002_requests.sql`.
7. ~~Orchestrator run lifecycle~~ **lab scale, safety scaffolding in PR #3, not a real change-request success path**. Phases: `queued → planning → awaiting_cp1 → coding → gates → (fixing ↔ gates) → awaiting_cp2 → awaiting_cp3`. CP1/CP2/CP3 are accepted only in the matching phase. The agent bearer cannot approve. `approve` requires `X-GB-Human-Authorization` (HS256 JWT with `sub`, `auth_time`, `exp`) signed by `GB_HUMAN_APPROVAL_SECRET`. `auth_time` is stored from the token and must be newer than `GB_HUMAN_AUTH_MAX_AGE_SECONDS` (default 300). Unset secret fails closed. This repo does not issue that JWT; wire it to the human IdP when Auth.js lands. Do not commit a production secret. CP3 sets `succeeded` only when `execution_mode=live` and `run_evidence` has an artifact plus verified passes of every required gate for the same `commit_sha`. Stub/inline runs stay `simulation` and CP3 ends `needs_human` / `simulation_not_success`. `GB_AGENT_ESTIMATE_USD` must be > 0 or the dispatch is `unbudgeted_estimate` and is not enqueued. The estimate, outbox row, and phase change commit in one transaction under `pg_advisory_xact_lock`. A missing Redis job for a still-open outbox row is enqueued again without a second charge. A completed outbox row is not executed again. Fix-loop cap and wall-clock timeout set a terminal status and cancel open dispatches. Apply `003_run_phase.sql` and `004_safety.sql` before deploy. Env: `DATABASE_URL`, `REDIS_URL`, `GB_MCP_TOKEN`, `GB_HUMAN_APPROVAL_SECRET`, `GB_HUMAN_AUTH_MAX_AGE_SECONDS`, `GB_AGENT_ESTIMATE_USD` (> 0), `ORCHESTRATOR_POLL_MS`, `ORCHESTRATOR_LEASE_SECONDS`, `ORCHESTRATOR_BATCH`, `GB_GATES_FAIL`.
8. Next: real Planner/coder that can set `execution_mode=live` only together with a real artifact and verified same-commit gate evidence; Auth.js as the human JWT issuer; admin UI. No Grok/Anthropic keys. The orchestrator does not promote to production.

Limitation, not a claim of exactly-once external execution: the worker moves a row to `running` and increments `executions` only while the run is active and inside `deadline_at`, then runs the stub, then sets `completed`. A second delivery does not run the handler. A crash after `running` is not left implicit: the next orchestrator tick, once `heartbeat_at` is older than `GB_DISPATCH_STALE_SECONDS`, sets the outbox to `needs_reconciliation` (`crash_after_running`) and the run to `needs_human`. If the run is expired or terminal after the stub has started, the outbox is `needs_reconciliation` with `external_effect_unknown`. That record does not mean an external call was killed. Without `DATABASE_URL` the worker does not execute jobs. CP3 reads `org_config.required_checks`, not a hardcoded list. GitHub CI job `safety-integration` runs this suite on ephemeral Postgres 16 and Redis 7 and fails if those URLs are missing (`GB_REQUIRE_SAFETY_INTEGRATION=1`). `pnpm test` still skips the suite when the URLs are unset. This is not a live Planner/coder/human-IdP end to end.

## Local verification

```bash
pnpm install && pnpm -r build
pnpm test:unit                    # in-memory lifecycle; CI runs this, not the database suite
# Real Postgres + Redis (local only; not Railway, not GitHub CI):
GB_TEST_DATABASE_URL='postgresql:///gb_safety?host=/var/run/postgresql' \
GB_TEST_REDIS_URL='redis://127.0.0.1:6379/1' \
  pnpm --filter @gb/orchestrator exec vitest run test/safety.integration.test.ts
```

The safety integration test is skipped when those URLs are unset. A skip is not a pass of that suite.
