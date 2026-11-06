-- Akshi / Green-Brown platform — initial lab schema
-- org_config caps, credit_ledger, runs, CP approvals, deployments.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE org_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL UNIQUE,
  max_fix_iterations integer NOT NULL DEFAULT 3,
  max_allowed_iterations integer NOT NULL DEFAULT 5,
  max_cost_usd numeric(12,4) NOT NULL DEFAULT 50,
  max_cost_usd_per_run numeric(12,4) NOT NULL DEFAULT 10,
  per_role_budget_usd jsonb NOT NULL DEFAULT '{"planner":5,"coder":8,"reviewer":3,"fixer":5,"reporter":2}'::jsonb,
  credit_alert_pct numeric(5,2) NOT NULL DEFAULT 80,
  max_wall_clock_seconds integer NOT NULL DEFAULT 28800,
  timeouts jsonb NOT NULL DEFAULT '{}'::jsonb,
  notify jsonb NOT NULL DEFAULT '{}'::jsonb,
  coding_agent text NOT NULL DEFAULT 'cursor',
  models jsonb NOT NULL DEFAULT '{}'::jsonb,
  allow_self_approval boolean NOT NULL DEFAULT true,
  protected_paths text[] NOT NULL DEFAULT ARRAY['.github/**', 'infra/**'],
  required_checks text[] NOT NULL DEFAULT ARRAY[
    'lint','typecheck','unit','functional','e2e','reviewer','acceptance','sast','load_pr','load_staging'
  ],
  require_prod_approval boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

CREATE TABLE credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  request_id uuid,
  run_id uuid,
  role text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  in_tokens integer NOT NULL DEFAULT 0,
  out_tokens integer NOT NULL DEFAULT 0,
  cost_usd numeric(12,6) NOT NULL,
  reason text NOT NULL DEFAULT 'llm_complete',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_ledger_org_idx ON credit_ledger (org_id, created_at);
CREATE INDEX credit_ledger_run_idx ON credit_ledger (run_id);
CREATE INDEX credit_ledger_role_idx ON credit_ledger (org_id, run_id, role);

CREATE TABLE llm_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid,
  role text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  in_tokens integer NOT NULL DEFAULT 0,
  out_tokens integer NOT NULL DEFAULT 0,
  cost_usd numeric(12,6) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL,
  plan_id uuid,
  branch text NOT NULL DEFAULT '',
  agent_kind text NOT NULL DEFAULT 'cursor',
  agent_run_id text,
  iteration integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','succeeded','escalated','needs_human','dead_letter','cancelled','live')),
  deadline_at timestamptz,
  lease_until timestamptz,
  heartbeat_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE INDEX runs_request_idx ON runs (request_id);

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL,
  checkpoint text NOT NULL CHECK (checkpoint IN ('CP1','CP2','CP3')),
  subject_hash text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved','changes_requested')),
  comment text,
  user_id text NOT NULL,
  client_id text,
  token_jti text,
  ip text,
  auth_time timestamptz NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approvals_request_cp_idx ON approvals (request_id, checkpoint);

CREATE TABLE deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid,
  request_id uuid,
  environment text NOT NULL CHECK (environment IN ('lab','staging','production')),
  commit_sha text NOT NULL,
  railway_deployment_id text,
  previous_deployment_id text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','promoting','live','failed','rolled_back')),
  health_status text DEFAULT 'unknown',
  rolled_back boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deployments_sha_idx ON deployments (commit_sha, environment);
