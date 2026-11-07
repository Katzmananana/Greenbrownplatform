import { type RunRecord, type RunStore, RunStoreError } from "../store/types.js";
import { CHECKPOINT_ORDER, isCheckpoint } from "../store/workflow.js";
import { HumanAuthError, type HumanAuthConfig, verifyHumanAuthorization } from "./human-auth.js";

export interface ToolContext {
  store: RunStore;
  /** Agent principal. Never written as the human approver. */
  principal: string;
  ip?: string | null;
  humanAuthorization?: string | null;
  humanAuth?: HumanAuthConfig;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type ToolPayload = Record<string, unknown>;

export type ToolHandler = (args: unknown, ctx: ToolContext) => Promise<ToolPayload>;

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent: ToolPayload;
  isError: boolean;
}

export const MAX_REQUEST_CHARS = 20_000;

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "create_run",
    title: "Create run",
    description:
      "Submit a free-text change request. Creates a run awaiting CP1 and returns its id and status.",
    inputSchema: {
      type: "object",
      properties: {
        request: { type: "string", minLength: 1, maxLength: MAX_REQUEST_CHARS },
      },
      required: ["request"],
      additionalProperties: false,
    },
  },
  {
    name: "get_run",
    title: "Get run",
    description: "Return status, checkpoint stage, and approvals for a run.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string", minLength: 1 } },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "approve",
    title: "Approve checkpoint",
    description:
      "Record a human approval only when X-GB-Human-Authorization carries a fresh human JWT and the orchestrator is waiting on that checkpoint: CP1 at awaiting_cp1, CP2 at awaiting_cp2, CP3 at awaiting_cp3. The agent bearer cannot approve. CP3 sets succeeded only when live same-commit artifact and verified gate evidence exist; simulation stays needs_human.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", minLength: 1 },
        checkpoint: { type: "string", enum: [...CHECKPOINT_ORDER] },
        comment: { type: "string" },
      },
      required: ["runId", "checkpoint"],
      additionalProperties: false,
    },
  },
];

export class UnknownToolError extends Error {
  constructor(name: string) {
    super(`unknown tool: ${name}`);
    this.name = "UnknownToolError";
  }
}

class ToolInputError extends Error {}

function asArgs(args: unknown): Record<string, unknown> {
  if (args == null) return {};
  if (typeof args !== "object" || Array.isArray(args)) {
    throw new ToolInputError("arguments must be an object");
  }
  return args as Record<string, unknown>;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolInputError(`${key} must be a non-empty string`);
  }
  return value.trim();
}

function summary(run: RunRecord): ToolPayload {
  return { ...run };
}

export const createRunTool: ToolHandler = async (args, ctx) => {
  const request = requiredString(asArgs(args), "request");
  if (request.length > MAX_REQUEST_CHARS) {
    throw new ToolInputError(`request must be at most ${MAX_REQUEST_CHARS} characters`);
  }
  const run = await ctx.store.createRun({ request });
  return {
    runId: run.runId,
    status: run.status,
    stage: run.stage,
    phase: run.phase,
    requestId: run.requestId,
  };
};

export const getRunTool: ToolHandler = async (args, ctx) => {
  const runId = requiredString(asArgs(args), "runId");
  const run = await ctx.store.getRun(runId);
  if (!run) throw new RunStoreError("not_found", `run ${runId} not found`);
  return summary(run);
};

export const approveTool: ToolHandler = async (args, ctx) => {
  const input = asArgs(args);
  const runId = requiredString(input, "runId");
  const checkpoint: unknown = input.checkpoint;
  if (!isCheckpoint(checkpoint)) {
    throw new ToolInputError(`checkpoint must be one of ${CHECKPOINT_ORDER.join(", ")}`);
  }
  const comment = input.comment;
  if (comment !== undefined && typeof comment !== "string") {
    throw new ToolInputError("comment must be a string");
  }
  const human = verifyHumanAuthorization(
    ctx.humanAuthorization,
    ctx.humanAuth ?? { maxAgeSeconds: 300 },
  );
  if (!human.ok) throw new HumanAuthError(human.code, human.message);
  const run = await ctx.store.approve({
    runId,
    checkpoint,
    userId: human.userId,
    authTime: human.authTime.toISOString(),
    comment: comment ?? null,
    ip: ctx.ip ?? null,
  });
  return { runId: run.runId, checkpoint, status: run.status, stage: run.stage, run: summary(run) };
};

const HANDLERS: Record<string, ToolHandler> = {
  create_run: createRunTool,
  get_run: getRunTool,
  approve: approveTool,
};

export function hasTool(name: string): boolean {
  return Object.hasOwn(HANDLERS, name);
}

/**
 * Run a tool. Input-validation and domain errors (not found, out-of-order
 * approval) come back as `isError: true` results so the model can correct
 * itself; an unknown tool name throws UnknownToolError (JSON-RPC -32602).
 */
export async function callTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const handler = hasTool(name) ? HANDLERS[name] : undefined;
  if (!handler) throw new UnknownToolError(name);
  try {
    const result = await handler(args, ctx);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
      isError: false,
    };
  } catch (err) {
    if (
      err instanceof ToolInputError ||
      err instanceof RunStoreError ||
      err instanceof HumanAuthError
    ) {
      const error = {
        error:
          err instanceof RunStoreError || err instanceof HumanAuthError
            ? err.code
            : "invalid_arguments",
        message: err.message,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(error) }],
        structuredContent: error,
        isError: true,
      };
    }
    throw err;
  }
}
