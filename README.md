# Akshi / Green-Brown Code Factory

Autonomous **Green (ירוקה)** / **Brown (חומה)** agentic CI/CD. The platform takes a free-text change request and runs analysis, planning, coding, review, tests, and a bounded fix loop. Humans approve only at three checkpoints:

- **CP1** — before code is written
- **CP2** — after the delivery package is ready
- **CP3** — before promotion to production (same commit SHA as staging)

This repository is the platform monorepo (`green-brown-platform`). It contains service skeletons, credit hard-stop, section-7 blocking CI, a CP3 promote workflow, a minimal gateway MCP server (`create_run`, `get_run`, `approve`), and the orchestrator run lifecycle (stub Planner/coder/fixer jobs). Real Planner, Cursor coding agent, and admin UI are not implemented yet.

## Lab scale

Railway project `green-brown-platform` (`aab01577-7b18-4462-a98a-e63fd5257a39`), environment `lab` (`e99cabae-42d5-46b9-a5a5-929f030e066a`). Lab is a single environment until a demo is live. Expected Railway spend at demo scale is about $15–40/month (LLM / Cursor / GitHub are extra and capped in `org_config`).

## Tear-down

Delete the Railway project `green-brown-platform` (the ID above). That removes services, plugins, and volumes. See `infra/railway/README.md`.

## Stack

TypeScript / Node 22 monorepo (pnpm workspaces). Apps: `gateway`, `orchestrator`, `web`, `worker`. Data: Postgres + Redis/BullMQ on Railway. CI: GitHub Actions.

## Local

```bash
pnpm install
pnpm -r build
pnpm --filter @gb/gateway start
# GET http://127.0.0.1:3000/health  →  200 {"status":"ok",...}
```

Other services: orchestrator `:3001`, web `:3002`, worker `:3003` (override with `PORT`). The orchestrator loop stays idle until `DATABASE_URL` is set. Without `REDIS_URL` it completes agent jobs in-process; with `REDIS_URL` it enqueues them for the worker.

```bash
pnpm lint
pnpm typecheck
pnpm test:unit          # includes credit hard-stop tests
pnpm test:functional    # gateway /health + credit middleware
pnpm test:e2e
```

## Gateway MCP (`POST /mcp`)

Minimal MCP server over HTTP: JSON-RPC 2.0, one message per POST, JSON responses (no SSE stream). Methods: `initialize`, `ping`, `tools/list`, `tools/call`. Notifications get `202` with no body. `GET /mcp` → `405`.

Tools:

| Tool | Input | Result |
|---|---|---|
| `create_run` | `{ request: string }` | `{ runId, status, stage, phase, requestId }` — new run, `status: "active"`, `phase: "queued"`, `stage: "awaiting_cp1"` |
| `get_run` | `{ runId: string }` | full run: `status`, `phase`, `stage`, `request`, `approvals[]`, `version`, timestamps |
| `approve` | `{ runId, checkpoint: "CP1"\|"CP2"\|"CP3", comment? }` | records the approval only when `phase` is `awaiting_cp1` / `awaiting_cp2` / `awaiting_cp3` for that checkpoint, in order, once each. CP3 at `awaiting_cp3` sets `status: "succeeded"` |

`stage` is still the next human checkpoint derived from approvals. `phase` is the orchestrator lifecycle. A fresh run reports `stage: "awaiting_cp1"` and `phase: "queued"`; CP1 is rejected with `not_ready` until planning finishes and `phase` is `awaiting_cp1`. CP2 waits until gates have passed. CP3 cannot close the run before that.

Tool failures come back as `result.isError: true` with `structuredContent.error` set to `invalid_arguments`, `not_found`, `out_of_order`, `already_approved`, `run_not_active`, or `not_ready`.

**Auth** — every `/mcp` call needs `Authorization: Bearer <token>`:

- `GB_MCP_TOKEN` set → the bearer must match it.
- `GB_MCP_TOKEN` unset and `NODE_ENV` is not `production` → **any non-empty bearer is accepted** (local/dev lab convenience only).
- `GB_MCP_TOKEN` unset and `NODE_ENV=production` (this includes Railway lab) → `503 mcp_auth_not_configured`. Set `GB_MCP_TOKEN` on the gateway service.

The credit hard-stop middleware still runs on `/mcp`, after auth.

**Storage** — with `DATABASE_URL` set the gateway uses Postgres (`runs`, `approvals`, and `requests` from `db/migrations/002_requests.sql`); otherwise runs live in memory and are lost on restart. `GB_RUN_STORE=memory` forces in-memory. The `pg` driver is loaded at runtime: if it isn't installed, the gateway logs a warning and uses memory. `GET /health` reports `runStore: "memory" | "postgres"`.

```bash
TOKEN=dev-anything   # any value works locally when GB_MCP_TOKEN is unset
URL=http://127.0.0.1:3000/mcp
H=(-H "authorization: Bearer $TOKEN" -H "content-type: application/json")

curl -s "${H[@]}" $URL -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
curl -s "${H[@]}" $URL -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
curl -s "${H[@]}" $URL -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"create_run","arguments":{"request":"add a /status page"}}}'
curl -s "${H[@]}" $URL -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"approve","arguments":{"runId":"<runId>","checkpoint":"CP1"}}}'
curl -s "${H[@]}" $URL -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"get_run","arguments":{"runId":"<runId>"}}}'
```

Claude Code: `claude mcp add --transport http gb-gateway http://127.0.0.1:3000/mcp --header "Authorization: Bearer $TOKEN"`.

## Orchestrator lifecycle

`apps/orchestrator` polls Postgres for runs the gateway created and advances `runs.phase` (migration `db/migrations/003_run_phase.sql`). MCP `stage` stays the next human checkpoint. The loop never writes `approvals`. It saves a transition only when `status` is still `active` and `version` matches.

| Phase | What happens |
|---|---|
| `queued` | Credit check, then enqueue a `plan` job. CP1 is rejected here |
| `planning` | Wait until the worker acks, then `awaiting_cp1` |
| `awaiting_cp1` | Park until gateway records CP1. No code job before that |
| `coding` | Wait for the `code` job, then run gates |
| `gates` | Logic-only §7 results (no CI calls). Failure uses `decideFixLoop`: retry enqueues `fix`, cap sets `status=escalated`. A green result does not set `succeeded` |
| `fixing` | Wait for the fixer job, then gates again |
| `awaiting_cp2` | Park until CP2. CP3 is still rejected |
| `awaiting_cp3` | Park until CP3. That approval is what sets `status=succeeded` |

Approvals already present do not skip planning, coding, or gates, and they do not close the run before `awaiting_cp3`. When `GB_AGENT_ESTIMATE_USD` is greater than 0, each new dispatch appends that estimate to `credit_ledger` once (same role and iteration is not charged again if the job is re-enqueued). Over budget sets `status=needs_human` and does not enqueue. `POST /internal/fix-loop/next` still returns a `decideFixLoop` decision for debugging; the loop is what applies it.

Gate results inside the run are placeholders. GitHub CI on this repo is also not a substitute for those run gates: `reviewer` passes only because `GATE_STUB=1`, `acceptance` matches a fixture, `sast` is a regex plus `pnpm audit`, `load` hammers gateway `/health` for two seconds, and `load-staging` / `e2e` are lab stubs. None of them execute the change request.

Worker (`apps/worker`) consumes BullMQ queue `jobs`. Handlers accept the payload (`v`, `name`, `runId`, `requestId`, `iteration`, `role`, `requestText`) and ack a stub result. They do not call a model.

| Env | Role |
|---|---|
| `DATABASE_URL` | Postgres. Unset → loop idle, health stays up |
| `REDIS_URL` | BullMQ. Unset → jobs complete inside the orchestrator and are **not** handed to the worker |
| `ORCHESTRATOR_POLL_MS` | Poll interval, default `2000` |
| `ORCHESTRATOR_LEASE_SECONDS` | Claim lease, default `30`. Not bumped on `runs.version` |
| `ORCHESTRATOR_BATCH` | Runs per tick, default `10` |
| `GB_AGENT_ESTIMATE_USD` | Estimated USD checked before each dispatch, default `0` (an already-over ledger still hard-stops) |
| `GB_GATES_FAIL` | Comma-separated gate names the stub runner fails, for lab fix-loop checks |
| `PORT` | HTTP port, default `3001` orchestrator / `3003` worker |

`GET /health` on the orchestrator reports `mode: "lifecycle"`, `queue` (`off` | `inline` | `bullmq`), and `lastError` (for example a missing `003_run_phase.sql`).

## Credits (section 7b)

Server-side `CreditGuard` in `@gb/credits` enforces `max_cost_usd`, `max_cost_usd_per_run`, and `per_role_budget_usd`. Crossing `credit_alert_pct` (default 80%) emits an alert. Exceeding a cap throws `CreditHardStopError` **before** any LLM `complete()` — agents cannot bypass it. Schema: `db/migrations/001_init.sql` (`org_config`, `credit_ledger`).
