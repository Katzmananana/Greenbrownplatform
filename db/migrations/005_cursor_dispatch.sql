-- Cursor Cloud Agents v1 handle for one dispatch.
-- Artifact columns are filled only from a provider response.
-- This is not run_evidence and it does not make a run succeeded.
-- Idempotent: safe to re-apply.

ALTER TABLE runs ADD COLUMN IF NOT EXISTS plan_text text;

COMMENT ON COLUMN runs.plan_text IS
  'Plan text stored before coding. A Cursor launch requires a non-empty value and a CP1 approval. This column is not produced by the adapter.';

CREATE TABLE IF NOT EXISTS cursor_dispatch (
  idempotency_key text PRIMARY KEY,
  run_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'cursor_cloud_agents_v1',
  intended_agent_id text NOT NULL,
  agent_id text,
  provider_run_id text,
  launch text NOT NULL CHECK (launch IN ('intent', 'launched', 'ambiguous', 'refused')),
  provider_status text,
  repo_url text,
  branch text,
  pr_url text,
  commit_sha text,
  agent_url text,
  result_text text,
  reconciliation text,
  cancel_confirmed boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE cursor_dispatch DROP CONSTRAINT IF EXISTS cursor_dispatch_launch_check;
ALTER TABLE cursor_dispatch ADD CONSTRAINT cursor_dispatch_launch_check
  CHECK (launch IN ('intent', 'launched', 'ambiguous', 'refused'));

COMMENT ON TABLE cursor_dispatch IS
  'Durable Cursor Cloud Agents v1 identity for one outbox row. commit_sha stays null unless a documented response field carries it. Get A Run git.branches has repoUrl, branch, and prUrl only.';
COMMENT ON COLUMN cursor_dispatch.cancel_confirmed IS
  'True only after Get A Run returns CANCELLED. A cancel POST by itself does not confirm the remote run stopped.';
