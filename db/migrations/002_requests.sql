-- Free-text change requests submitted via the gateway MCP `create_run` tool.
-- runs.request_id (001_init.sql) points at requests.id. No FK yet so existing
-- lab rows stay valid. Idempotent: safe to re-apply.

CREATE TABLE IF NOT EXISTS requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  text text NOT NULL,
  source text NOT NULL DEFAULT 'mcp',
  created_at timestamptz NOT NULL DEFAULT now()
);
