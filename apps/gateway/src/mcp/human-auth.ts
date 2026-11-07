import { createHmac, timingSafeEqual } from "node:crypto";

export interface HumanAuthConfig {
  /** HMAC secret for human approval JWTs. Unset → approve fails closed. */
  secret?: string;
  /** Maximum age of the `auth_time` claim, in seconds. */
  maxAgeSeconds: number;
  /** Agent bearer. Rejected if presented as the human credential. */
  agentCredential?: string;
}

export type HumanAuthCode =
  | "human_auth_not_configured"
  | "human_auth_required"
  | "human_auth_invalid"
  | "human_auth_stale";

export type HumanAuthResult =
  | { ok: true; userId: string; authTime: Date }
  | { ok: false; code: HumanAuthCode; message: string };

export class HumanAuthError extends Error {
  readonly code: HumanAuthCode;

  constructor(code: HumanAuthCode, message: string) {
    super(message);
    this.code = code;
    this.name = "HumanAuthError";
  }
}

const SKEW_SECONDS = 30;

export function readHumanAuthConfig(env: NodeJS.ProcessEnv = process.env): HumanAuthConfig {
  const maxAge = Number(env.GB_HUMAN_AUTH_MAX_AGE_SECONDS ?? 300);
  return {
    secret: env.GB_HUMAN_APPROVAL_SECRET?.trim() || undefined,
    maxAgeSeconds: Number.isFinite(maxAge) && maxAge > 0 ? Math.floor(maxAge) : 300,
    agentCredential: env.GB_MCP_TOKEN?.trim() || undefined,
  };
}

/** Test fixture signer. Production JWTs come from the human IdP, not this process. */
export function signHumanJwt(
  secret: string,
  claims: { sub: string; authTime: number; exp: number },
): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ sub: claims.sub, auth_time: claims.authTime, exp: claims.exp }),
  );
  const data = `${header}.${payload}`;
  const sig = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

/**
 * Fail closed unless the header is a signed human JWT whose `auth_time` is fresh.
 * `auth_time` is taken from the token. This function does not stamp "now".
 */
export function verifyHumanAuthorization(
  header: string | null | undefined,
  config: HumanAuthConfig,
  nowSeconds = Math.floor(Date.now() / 1000),
): HumanAuthResult {
  const secret = config.secret?.trim();
  if (!secret) {
    return {
      ok: false,
      code: "human_auth_not_configured",
      message: "GB_HUMAN_APPROVAL_SECRET is unset; human approval is fail-closed",
    };
  }
  const token = parseBearer(header);
  if (!token) {
    return {
      ok: false,
      code: "human_auth_required",
      message: "X-GB-Human-Authorization: Bearer <jwt> required for approve",
    };
  }
  if (config.agentCredential && token === config.agentCredential) {
    return {
      ok: false,
      code: "human_auth_invalid",
      message: "agent credential cannot authorize a human checkpoint",
    };
  }
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return { ok: false, code: "human_auth_invalid", message: "human JWT is malformed" };
  }
  const data = `${parts[0]}.${parts[1]}`;
  const expected = createHmac("sha256", secret).update(data).digest("base64url");
  const actual = parts[2];
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, code: "human_auth_invalid", message: "human JWT signature is invalid" };
  }
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return { ok: false, code: "human_auth_invalid", message: "human JWT payload is not JSON" };
  }
  if (typeof claims.sub !== "string" || claims.sub.trim().length === 0) {
    return { ok: false, code: "human_auth_invalid", message: "human JWT sub is required" };
  }
  if (typeof claims.auth_time !== "number" || !Number.isFinite(claims.auth_time)) {
    return { ok: false, code: "human_auth_invalid", message: "human JWT auth_time is required" };
  }
  if (typeof claims.exp !== "number" || claims.exp < nowSeconds) {
    return { ok: false, code: "human_auth_invalid", message: "human JWT is expired" };
  }
  if (claims.auth_time > nowSeconds + SKEW_SECONDS) {
    return {
      ok: false,
      code: "human_auth_invalid",
      message: "human JWT auth_time is in the future",
    };
  }
  if (nowSeconds - claims.auth_time > config.maxAgeSeconds) {
    return {
      ok: false,
      code: "human_auth_stale",
      message: `human reauthentication is older than ${config.maxAgeSeconds}s`,
    };
  }
  return { ok: true, userId: claims.sub.trim(), authTime: new Date(claims.auth_time * 1000) };
}

function parseBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}
