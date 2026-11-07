-- Orchestrator lifecycle phase on runs.
-- Gateway MCP does not read this column. It still derives checkpoint stage
-- from approvals and sets status = succeeded when CP3 is approved.
-- Idempotent: safe to re-apply.

ALTER TABLE runs ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT 'queued';
ALTER TABLE runs ADD COLUMN IF NOT EXISTS phase_reason text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'runs_phase_check'
  ) THEN
    ALTER TABLE runs
      ADD CONSTRAINT runs_phase_check
      CHECK (phase IN (
        'queued',
        'planning',
        'awaiting_cp1',
        'coding',
        'gates',
        'fixing',
        'awaiting_cp2',
        'awaiting_cp3'
      ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS runs_active_phase_idx
  ON runs (phase, started_at)
  WHERE status = 'active';

COMMENT ON COLUMN runs.phase IS
  'Orchestrator lifecycle (queued..awaiting_cp3). Not the MCP checkpoint stage.';
