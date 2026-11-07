import { parseAgentJobPayload } from "@gb/shared";

export interface HandledJob {
  ok: true;
  /** False when a Cursor Cloud Agents call was attempted or refused by policy. */
  stub: boolean;
  name: string;
  runId: string | null;
  requestId: string | null;
  iteration: number | null;
  role: string | null;
  provider?: "cursor_cloud_agents_v1";
}

export interface HandlerControl {
  /** Cooperative stop. Checked at boundaries. Does not abort an external call. */
  cancelled(): boolean;
}

export type HandlerResult = HandledJob & {
  /** none = stub effect did not start. unknown = effect may have started and was not revoked. */
  externalEffect: "none" | "unknown";
};

/**
 * Lab handler. Recognises orchestrator payloads and acks them.
 * Planner / coder / fixer agents are not called.
 * If `cancelled()` is true before the log, the stub effect does not start.
 * If it becomes true after the log, the effect is reported unknown.
 */
export function handleAgentJob(
  name: string,
  data: unknown,
  control?: HandlerControl,
): HandlerResult {
  const payload = parseAgentJobPayload(data);
  const result: HandlerResult = {
    ok: true,
    stub: true,
    name: payload?.name ?? name,
    runId: payload?.runId ?? null,
    requestId: payload?.requestId ?? null,
    iteration: payload?.iteration ?? null,
    role: payload?.role ?? null,
    externalEffect: "none",
  };
  if (control?.cancelled()) return result;
  console.log(JSON.stringify({ msg: "worker handled job", ...result }));
  if (control?.cancelled()) return { ...result, externalEffect: "unknown" };
  return result;
}
