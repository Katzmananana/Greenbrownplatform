# Railway mapping — green-brown-platform

Lab project already exists. Tear-down = delete this Railway project (not individual services).

| | |
|---|---|
| Project name | `green-brown-platform` |
| Project ID | `aab01577-7b18-4462-a98a-e63fd5257a39` |
| Environment `lab` | `e99cabae-42d5-46b9-a5a5-929f030e066a` |
| Region (plan default) | `europe-west4` |
| Scale | lab only until a live demo exists; expected Railway spend about $15–40/month at demo scale |

## Services

| Service | Kind | Public? | Health | Start (after build) | Notes |
|---|---|---|---|---|---|
| `gateway` | web, Node 22 | yes | `GET /health` (also `/healthz`) | `pnpm --filter @gb/gateway start` | REST + MCP stub + credit hard-stop hook |
| `orchestrator` | web, Node 22 | private | `GET /health` | `pnpm --filter @gb/orchestrator start` | fix-loop stub; later: `releaseCommand` = migrate |
| `web` | web, Node 22 | yes | `GET /health` | `pnpm --filter @gb/web start` | admin stub page |
| `worker` | worker, Node 22 | private | `GET /health` | `pnpm --filter @gb/worker start` | BullMQ consumer stub (needs `REDIS_URL`) |
| `Postgres` | plugin | private | n/a | n/a | injects `DATABASE_URL` — blocked on Free until Hobby |
| `Redis` | plugin | private | n/a | n/a | injects `REDIS_URL` — already present |

Root directory for each service: repository root (this monorepo). Watch paths can later be narrowed per service.

## Hobby unlock

Free plan blocked additional services (Postgres, orchestrator, web, worker). Upgrade the project to Hobby (~$5/month) before connecting those sources. Then set shared variables and attach GitHub as the source for each service.

## Tear-down

Delete project `green-brown-platform` (`aab01577-7b18-4462-a98a-e63fd5257a39`) in the Railway dashboard. That removes environments, services, volumes, and plugins.
