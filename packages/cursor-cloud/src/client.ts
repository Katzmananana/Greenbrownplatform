import { cursorAgentIdForDispatch } from "./policy.js";

export class CursorCloudError extends Error {
  constructor(
    message: string,
    readonly kind: "unauthorized" | "conflict" | "not_found" | "unavailable" | "invalid",
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "CursorCloudError";
  }
}

export interface CreateAgentRequest {
  prompt: { text: string };
  name?: string;
  repos: [{ url: string; startingRef: string }];
  workOnCurrentBranch: false;
  autoCreatePR: true;
  skipReviewerRequest: true;
  mode: "agent";
  agentId: string;
}

export interface CursorAgent {
  id: string;
  url?: string;
  latestRunId?: string;
  status?: string;
}

export interface CursorRun {
  id: string;
  agentId: string;
  status: string;
  result?: string;
  git?: unknown;
}

export interface CursorCloudClient {
  createAgent(body: CreateAgentRequest): Promise<{ agent: CursorAgent; run: CursorRun }>;
  getAgent(agentId: string): Promise<CursorAgent>;
  getRun(agentId: string, runId: string): Promise<CursorRun>;
  cancelRun(agentId: string, runId: string): Promise<{ id: string }>;
}

/**
 * Public Cloud Agents API v1. Auth is `Authorization: Bearer`.
 * This client does not send `envVars` (incompatible with a client `agentId`)
 * and does not choose a model. The account default is not a spend cap.
 * `GET /v1/agents/{id}/usage` reports tokens after the fact and is not called.
 */
export function createCursorCloudClient(options: {
  apiKey: string;
  apiBase: string;
  fetchImpl?: typeof fetch;
}): CursorCloudClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.apiBase.replace(/\/+$/, "");

  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        redirect: "error",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new CursorCloudError(message, "unavailable", 0);
    }
    const text = await response.text();
    const parsed = text ? safeJson(text) : {};
    if (response.ok) return parsed;
    const code = errorCode(parsed);
    if (response.status === 401 || response.status === 403) {
      throw new CursorCloudError(
        "cursor api rejected the credential",
        "unauthorized",
        response.status,
        code,
      );
    }
    if (response.status === 404) {
      throw new CursorCloudError(
        "cursor api resource was not found",
        "not_found",
        response.status,
        code,
      );
    }
    if (response.status === 409) {
      throw new CursorCloudError(code ?? "conflict", "conflict", response.status, code);
    }
    if (response.status >= 500 || response.status === 408 || response.status === 429) {
      throw new CursorCloudError(
        "cursor api was unavailable",
        "unavailable",
        response.status,
        code,
      );
    }
    throw new CursorCloudError("cursor api rejected the request", "invalid", response.status, code);
  }

  return {
    async createAgent(body) {
      const parsed = await request("POST", "/v1/agents", body);
      const agent = asAgent(parsed);
      const run = asRun(parsed);
      if (!agent || !run) {
        throw new CursorCloudError(
          "create agent response was missing agent or run",
          "invalid",
          200,
        );
      }
      return { agent, run };
    },
    async getAgent(agentId) {
      const parsed = await request("GET", `/v1/agents/${encodeURIComponent(agentId)}`);
      const agent = asAgent({ agent: parsed });
      if (!agent) throw new CursorCloudError("get agent response was missing id", "invalid", 200);
      return agent;
    },
    async getRun(agentId, runId) {
      const parsed = await request(
        "GET",
        `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
      );
      const run = asRun({ run: parsed });
      if (!run)
        throw new CursorCloudError("get run response was missing id or status", "invalid", 200);
      return run;
    },
    async cancelRun(agentId, runId) {
      const parsed = await request(
        "POST",
        `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/cancel`,
      );
      const id =
        typeof parsed === "object" && parsed && "id" in parsed
          ? (parsed as { id?: unknown }).id
          : undefined;
      if (typeof id !== "string" || !id) {
        throw new CursorCloudError("cancel response was missing id", "invalid", 200);
      }
      return { id };
    },
  };
}

export function buildCodingPrompt(requestText: string, planText: string): string {
  return [
    "Implement the approved plan in the configured repository.",
    "The plan text below was stored for this run. It is not inferred by this adapter.",
    "",
    "Request:",
    requestText.trim(),
    "",
    "Approved plan:",
    planText.trim(),
  ].join("\n");
}

export function buildCreateAgentBody(input: {
  idempotencyKey: string;
  requestText: string;
  planText: string;
  repoUrl: string;
  startingRef: string;
  runId: string;
}): CreateAgentRequest {
  return {
    prompt: { text: buildCodingPrompt(input.requestText, input.planText) },
    name: `gb ${input.runId}`.slice(0, 100),
    repos: [{ url: input.repoUrl, startingRef: input.startingRef }],
    workOnCurrentBranch: false,
    autoCreatePR: true,
    skipReviewerRequest: true,
    mode: "agent",
    agentId: cursorAgentIdForDispatch(input.idempotencyKey),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

function errorCode(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const row = parsed as { code?: unknown; error?: unknown };
  if (typeof row.code === "string") return row.code;
  if (typeof row.error === "string") return row.error;
  return undefined;
}

function asAgent(parsed: unknown): CursorAgent | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const row = (parsed as { agent?: unknown }).agent;
  if (typeof row !== "object" || row === null) return null;
  const id = (row as { id?: unknown }).id;
  if (typeof id !== "string" || !id.startsWith("bc-")) return null;
  const latest = (row as { latestRunId?: unknown }).latestRunId;
  const url = (row as { url?: unknown }).url;
  const status = (row as { status?: unknown }).status;
  return {
    id,
    ...(typeof latest === "string" ? { latestRunId: latest } : {}),
    ...(typeof url === "string" ? { url } : {}),
    ...(typeof status === "string" ? { status } : {}),
  };
}

function asRun(parsed: unknown): CursorRun | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const row = (parsed as { run?: unknown }).run;
  if (typeof row !== "object" || row === null) return null;
  const id = (row as { id?: unknown }).id;
  const agentIdValue = (row as { agentId?: unknown }).agentId;
  const status = (row as { status?: unknown }).status;
  if (typeof id !== "string" || typeof agentIdValue !== "string" || typeof status !== "string") {
    return null;
  }
  const result = (row as { result?: unknown }).result;
  return {
    id,
    agentId: agentIdValue,
    status,
    ...(typeof result === "string" ? { result } : {}),
    git: (row as { git?: unknown }).git,
  };
}
