import { TOOL_DEFINITIONS, type ToolContext, UnknownToolError, callTool } from "./tools.js";

export const SERVER_INFO = { name: "gb-gateway", title: "Green/Brown gateway", version: "0.1.0" };

/** Newest first. We echo the client's version when supported, else offer the newest. */
export const LATEST_PROTOCOL_VERSION = "2025-11-25";
export const SUPPORTED_PROTOCOL_VERSIONS = [
  LATEST_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

export const JSONRPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

type JsonRpcId = string | number | null;

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string; data?: unknown } };

export function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Dispatch one JSON-RPC message. Returns null for notifications and for
 * client-sent responses (the HTTP layer answers those with 202, no body).
 */
export async function handleJsonRpc(
  message: unknown,
  ctx: ToolContext,
): Promise<JsonRpcResponse | null> {
  if (!isObject(message) || message.jsonrpc !== "2.0") {
    return rpcError(null, JSONRPC_ERRORS.invalidRequest, "invalid JSON-RPC 2.0 request");
  }
  if (typeof message.method !== "string") {
    if ("result" in message || "error" in message) return null;
    return rpcError(null, JSONRPC_ERRORS.invalidRequest, "method must be a string");
  }
  if (!("id" in message)) {
    // Notifications (e.g. notifications/initialized) need no reply.
    return null;
  }
  const { id } = message;
  if (typeof id !== "string" && typeof id !== "number") {
    return rpcError(null, JSONRPC_ERRORS.invalidRequest, "id must be a string or number");
  }
  const params = message.params === undefined ? {} : message.params;
  if (!isObject(params)) {
    return rpcError(id, JSONRPC_ERRORS.invalidParams, "params must be an object");
  }

  try {
    switch (message.method) {
      case "initialize": {
        const requested = params.protocolVersion;
        const protocolVersion =
          typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : LATEST_PROTOCOL_VERSION;
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions:
              "Green/Brown run control: create_run, get_run, approve (CP1 -> CP2 -> CP3).",
          },
        };
      }
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: TOOL_DEFINITIONS } };
      case "tools/call": {
        if (typeof params.name !== "string") {
          return rpcError(id, JSONRPC_ERRORS.invalidParams, "params.name must be a string");
        }
        const result = await callTool(params.name, params.arguments, ctx);
        return { jsonrpc: "2.0", id, result };
      }
      default:
        return rpcError(id, JSONRPC_ERRORS.methodNotFound, `method not found: ${message.method}`);
    }
  } catch (err) {
    if (err instanceof UnknownToolError) {
      return rpcError(id, JSONRPC_ERRORS.invalidParams, err.message);
    }
    console.error(
      JSON.stringify({
        msg: "mcp internal error",
        method: message.method,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return rpcError(id, JSONRPC_ERRORS.internalError, "internal error");
  }
}
