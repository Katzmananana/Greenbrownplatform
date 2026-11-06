# Akshi / Green-Brown Code Factory

Autonomous **Green (ירוקה)** / **Brown (חומה)** agentic CI/CD. The platform takes a free-text change request and runs analysis, planning, coding, review, tests, and a bounded fix loop. Humans approve only at three checkpoints:

- **CP1** — before code is written
- **CP2** — after the delivery package is ready
- **CP3** — before promotion to production (same commit SHA as staging)

This repository is the platform monorepo (`green-brown-platform`). It currently contains **infra + gates only**: service stubs, credit hard-stop, section-7 blocking CI, and a CP3 promote workflow. Product features (Planner, Cursor coding agent, MCP tools, admin UI) are intentionally not implemented yet.

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

Other stubs: orchestrator `:3001`, web `:3002`, worker `:3003` (override with `PORT`).

```bash
pnpm lint
pnpm typecheck
pnpm test:unit          # includes credit hard-stop tests
pnpm test:functional    # gateway /health + credit middleware
pnpm test:e2e
```

## Credits (section 7b)

Server-side `CreditGuard` in `@gb/credits` enforces `max_cost_usd`, `max_cost_usd_per_run`, and `per_role_budget_usd`. Crossing `credit_alert_pct` (default 80%) emits an alert. Exceeding a cap throws `CreditHardStopError` **before** any LLM `complete()` — agents cannot bypass it. Schema: `db/migrations/001_init.sql` (`org_config`, `credit_ledger`).
