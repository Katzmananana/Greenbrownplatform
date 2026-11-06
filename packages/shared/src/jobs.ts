export const JOB_QUEUE_NAME = "jobs";

export type AgentJobName = "plan" | "code" | "fix";

export interface AgentJobPayload {
  v: 1;
  name: AgentJobName;
  runId: string;
  requestId: string;
  iteration: number;
  role: "planner" | "coder" | "fixer";
  requestText: string | null;
}

const ROLE_BY_NAME = {
  plan: "planner",
  code: "coder",
  fix: "fixer",
} as const satisfies Record<AgentJobName, AgentJobPayload["role"]>;

/**
 * BullMQ job ids cannot contain `:`. The id is the idempotency key so a
 * crashed orchestrator can enqueue the same dispatch again safely.
 */
export function agentJobId(parts: {
  name: AgentJobName;
  runId: string;
  iteration: number;
}): string {
  return `${parts.name}.${parts.runId}.${parts.iteration}`;
}

export function parseAgentJobPayload(data: unknown): AgentJobPayload | null {
  if (typeof data !== "object" || data === null) return null;
  const row = data as Record<string, unknown>;
  if (row.v !== 1) return null;
  if (row.name !== "plan" && row.name !== "code" && row.name !== "fix") return null;
  if (typeof row.runId !== "string" || row.runId.length === 0) return null;
  if (typeof row.requestId !== "string" || row.requestId.length === 0) return null;
  if (typeof row.iteration !== "number" || !Number.isInteger(row.iteration) || row.iteration < 0) {
    return null;
  }
  const role = ROLE_BY_NAME[row.name];
  if (row.role !== role) return null;
  if (row.requestText !== null && typeof row.requestText !== "string") return null;
  return {
    v: 1,
    name: row.name,
    runId: row.runId,
    requestId: row.requestId,
    iteration: row.iteration,
    role,
    requestText: row.requestText,
  };
}
