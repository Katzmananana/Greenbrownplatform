# Run artifact (lab fixture)

Akshi Green-Brown Code Factory skeleton.

- GET /health returns JSON `{ "status": "ok" }` from the gateway.
- CreditGuard.assertCanSpend / completeWithCreditGuard run server-side before any LLM call and throw CreditHardStopError (escalation NEEDS_HUMAN). The agent cannot bypass this hook.
- GitHub Actions ci.yml defines blocking jobs that block merge unless all section-7 gates pass: lint, typecheck, unit, functional, e2e, reviewer, acceptance, sast, load, load-staging, fix-loop.
- promote.yml requires the GitHub `production` environment (human CP3 approval) before production promote; post-promote health failure triggers automatic rollback when health fails.
