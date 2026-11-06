import { parseAgentJobPayload } from "@gb/shared";

export interface HandledJob {
  ok: true;
  stub: true;
  name: string;
  runId: string | null;
  requestId: string | null;
  iteration: number | null;
  role: string | null;
}

/**
 * Lab handler. Recognises orchestrator payloads and acks them.
 * Planner / coder / fixer agents are not called.
 */
export function handleAgentJob(name: string, data: unknown): HandledJob {
  const payload = parseAgentJobPayload(data);
  const result: HandledJob = {
    ok: true,
    stub: true,
    name: payload?.name ?? name,
    runId: payload?.runId ?? null,
    requestId: payload?.requestId ?? null,
    iteration: payload?.iteration ?? null,
    role: payload?.role ?? null,
  };
  console.log(JSON.stringify({ msg: "worker handled job", ...result }));
  return result;
}
