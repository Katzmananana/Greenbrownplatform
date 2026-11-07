import { createHash } from "node:crypto";

/**
 * The only repository this platform may hand to Cursor Cloud Agents.
 * TalentFit and any other URL are refused, even if an env var names them.
 */
export const APPROVED_CURSOR_REPOSITORY = "https://github.com/Katzmananana/Greenbrownplatform";

export const CURSOR_API_DEFAULT_BASE = "https://api.cursor.com";

const ACTIVE_STATUSES = new Set(["CREATING", "RUNNING", "WAITING_FOR_BACKGROUND_WORK"]);
const TERMINAL_STATUSES = new Set(["FINISHED", "ERROR", "CANCELLED", "EXPIRED"]);

export function normalizeRepositoryUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!host || path === "" || path === "/") return null;
  return `https://${host}${path}`;
}

export function isApprovedRepository(input: string): boolean {
  const candidate = normalizeRepositoryUrl(input);
  const approved = normalizeRepositoryUrl(APPROVED_CURSOR_REPOSITORY);
  return candidate !== null && candidate === approved;
}

/**
 * Documented client agent ids look like `bc-` plus a UUID
 * (`bc-00000000-0000-0000-0000-000000000001`). The same id makes a repeat
 * create return 409 `agent_id_conflict` instead of a second agent.
 * There is no documented Idempotency-Key header.
 */
export function cursorAgentIdForDispatch(idempotencyKey: string): string {
  const hash = createHash("sha256").update(`gb-cursor-cloud-agent:v1:${idempotencyKey}`).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return `bc-${uuid}`;
}

export function classifyRunStatus(
  status: string,
): "active" | "finished" | "terminal" | "unrecognized" {
  if (ACTIVE_STATUSES.has(status)) return "active";
  if (status === "FINISHED") return "finished";
  if (TERMINAL_STATUSES.has(status)) return "terminal";
  return "unrecognized";
}

export interface ProviderGitRef {
  repoUrl: string;
  branch: string | null;
  prUrl: string | null;
}

/**
 * Documented `git.branches[]` entries are `{ repoUrl, branch?, prUrl? }`.
 * `repoUrl` has no scheme. Commit SHA is not a documented run field, so this
 * reader never invents one.
 */
export function readProviderGit(run: unknown): ProviderGitRef | null {
  if (typeof run !== "object" || run === null) return null;
  const git = (run as { git?: unknown }).git;
  if (typeof git !== "object" || git === null) return null;
  const branches = (git as { branches?: unknown }).branches;
  if (!Array.isArray(branches) || branches.length === 0) return null;
  const first = branches[0];
  if (typeof first !== "object" || first === null) return null;
  const repoUrl = (first as { repoUrl?: unknown }).repoUrl;
  if (typeof repoUrl !== "string" || !isApprovedRepository(repoUrl)) return null;
  const branch = (first as { branch?: unknown }).branch;
  const prUrl = (first as { prUrl?: unknown }).prUrl;
  return {
    repoUrl,
    branch: typeof branch === "string" && branch.length > 0 ? branch : null,
    prUrl: typeof prUrl === "string" && prUrl.length > 0 ? prUrl : null,
  };
}

export type CursorExecutorConfig =
  | { mode: "off" }
  | { mode: "refused"; reason: string }
  | {
      mode: "ready";
      apiKey: string;
      apiBase: string;
      repoUrl: string;
      startingRef: string;
    };

export function readCursorExecutorConfig(
  env: NodeJS.ProcessEnv = process.env,
): CursorExecutorConfig {
  const flag = env.GB_CURSOR_EXECUTOR?.trim() ?? "";
  if (flag === "") return { mode: "off" };
  if (flag !== "1") return { mode: "refused", reason: "cursor_executor_flag" };
  const apiKey = (env.CURSOR_API_KEY ?? env.GB_CURSOR_API_KEY ?? "").trim();
  if (!apiKey) return { mode: "refused", reason: "cursor_credential_missing" };
  const repo = (env.GB_CURSOR_REPO_URL ?? "").trim();
  if (!isApprovedRepository(repo))
    return { mode: "refused", reason: "cursor_repo_not_allowlisted" };
  const startingRef = (env.GB_CURSOR_STARTING_REF ?? "main").trim();
  if (!startingRef || startingRef.includes(" ") || startingRef.startsWith("-")) {
    return { mode: "refused", reason: "cursor_starting_ref" };
  }
  const apiBase = (env.GB_CURSOR_API_BASE ?? CURSOR_API_DEFAULT_BASE).trim().replace(/\/+$/, "");
  let base: URL;
  try {
    base = new URL(apiBase);
  } catch {
    return { mode: "refused", reason: "cursor_api_base" };
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    return { mode: "refused", reason: "cursor_api_base" };
  }
  if (base.protocol === "http:" && base.hostname !== "127.0.0.1" && base.hostname !== "localhost") {
    return { mode: "refused", reason: "cursor_api_base" };
  }
  return {
    mode: "ready",
    apiKey,
    apiBase: base.origin,
    repoUrl: normalizeRepositoryUrl(repo) ?? APPROVED_CURSOR_REPOSITORY,
    startingRef,
  };
}
