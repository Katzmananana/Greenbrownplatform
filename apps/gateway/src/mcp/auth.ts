import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export interface McpAuthConfig {
  /** Expected bearer token (env GB_MCP_TOKEN). */
  token?: string;
  /** NODE_ENV. With no token configured, "production" fails closed. */
  nodeEnv?: string;
}

export type AuthResult =
  | { ok: true; principal: string }
  | { ok: false; status: 401 | 503; error: string; message: string };

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token ? token : null;
}

/**
 * - GB_MCP_TOKEN set: the bearer must match it exactly (constant-time compare).
 * - GB_MCP_TOKEN unset and NODE_ENV !== "production": any non-empty bearer is
 *   accepted (local/dev lab convenience).
 * - GB_MCP_TOKEN unset and NODE_ENV === "production": every call is rejected.
 */
export function checkBearer(header: string | undefined, config: McpAuthConfig): AuthResult {
  const expected = config.token?.trim();
  if (!expected && config.nodeEnv === "production") {
    return {
      ok: false,
      status: 503,
      error: "mcp_auth_not_configured",
      message: "GB_MCP_TOKEN must be set when NODE_ENV=production",
    };
  }
  const presented = parseBearer(header);
  if (!presented) {
    return {
      ok: false,
      status: 401,
      error: "unauthorized",
      message: "Authorization: Bearer <token> required",
    };
  }
  const presentedHash = sha256(presented);
  if (expected && !timingSafeEqual(presentedHash, sha256(expected))) {
    return { ok: false, status: 401, error: "unauthorized", message: "invalid bearer token" };
  }
  return { ok: true, principal: `bearer:${presentedHash.toString("hex").slice(0, 12)}` };
}

export function mcpAuthMiddleware(config: McpAuthConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = checkBearer(req.header("authorization"), config);
    if (!result.ok) {
      if (result.status === 401) res.setHeader("WWW-Authenticate", 'Bearer realm="gb-mcp"');
      res.status(result.status).json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32001, message: result.message, data: { error: result.error } },
      });
      return;
    }
    res.locals.mcpPrincipal = result.principal;
    next();
  };
}
