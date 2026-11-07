-- Safety scaffolding: human approval is not success by itself, dispatches are
-- reserved in the same transaction as the phase change, and a completed
-- dispatch stays completed after the Redis result is gone.
-- Idempotent: safe to re-apply.

ALTER TABLE runs ADD COLUMN IF NOT EXISTS execution_mode text NOT NULL DEFAULT 'simulation';
ALTER TABLE runs ADD COLUMN IF NOT EXISTS commit_sha text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'runs_execution_mode_check'
  ) THEN
    ALTER TABLE runs
      ADD CONSTRAINT runs_execution_mode_check
      CHECK (execution_mode IN ('simulation', 'live'));
  END IF;
END $$;

COMMENT ON COLUMN runs.execution_mode IS
  'simulation cannot become status=succeeded. live still needs artifact and verified gates for commit_sha.';

CREATE TABLE IF NOT EXISTS dispatch_outbox (
  idempotency_key text PRIMARY KEY,
  org_id uuid NOT NULL,
  run_id uuid NOT NULL,
  request_id uuid,
  job_name text NOT NULL,
  role text NOT NULL,
  iteration integer NOT NULL,
  payload jsonb NOT NULL,
  cost_usd numeric(12, 6) NOT NULL CHECK (cost_usd > 0),
  state text NOT NULL CHECK (state IN (
    'pending', 'enqueued', 'running', 'completed', 'cancelled', 'failed', 'needs_reconciliation'
  )),
  executions integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  enqueued_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS dispatch_outbox_run_idx ON dispatch_outbox (run_id, state);

-- Re-apply so databases created before `running` existed pick it up.
ALTER TABLE dispatch_outbox ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;
ALTER TABLE dispatch_outbox ADD COLUMN IF NOT EXISTS reconciliation text;

ALTER TABLE dispatch_outbox DROP CONSTRAINT IF EXISTS dispatch_outbox_state_check;
ALTER TABLE dispatch_outbox ADD CONSTRAINT dispatch_outbox_state_check
  CHECK (state IN (
    'pending', 'enqueued', 'running', 'completed', 'cancelled', 'failed', 'needs_reconciliation'
  ));

COMMENT ON COLUMN dispatch_outbox.reconciliation IS
  'Set when a running dispatch crashes or is cancelled in flight. Does not mean an external call was stopped.';

CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_dispatch_uidx
  ON credit_ledger (run_id, reason)
  WHERE reason LIKE 'orchestrator_dispatch:%';

CREATE TABLE IF NOT EXISTS run_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  commit_sha text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('artifact', 'gate')),
  gate_name text,
  mode text NOT NULL CHECK (mode IN ('simulation', 'verified')),
  passed boolean,
  uri text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS run_evidence_artifact_uidx
  ON run_evidence (run_id, commit_sha)
  WHERE kind = 'artifact';

CREATE UNIQUE INDEX IF NOT EXISTS run_evidence_gate_uidx
  ON run_evidence (run_id, commit_sha, gate_name)
  WHERE kind = 'gate';

COMMENT ON TABLE dispatch_outbox IS
  'Transactional outbox. Redis is transport. Completion and the charge live here.';
COMMENT ON TABLE run_evidence IS
  'Artifact and gate evidence. mode=simulation is never enough for status=succeeded.';
