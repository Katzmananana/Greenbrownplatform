import type { NextFunction, Request, Response } from "express";
import { type CreditGuard, CreditHardStopError } from "@gb/credits";
import type { AgentRole } from "@gb/shared";

const ROLES: ReadonlySet<string> = new Set(["planner", "coder", "reviewer", "fixer", "reporter"]);

function header(req: Request, name: string): string | undefined {
  const raw = req.header(name);
  return raw && raw.trim().length > 0 ? raw.trim() : undefined;
}

/**
 * Server-side hook: any route that would call an LLM must run this first.
 * The agent cannot skip it — there is no client-side override flag.
 */
export function creditHardStopMiddleware(guard: CreditGuard) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const rawCost = header(req, "x-gb-estimate-cost-usd");
    const estimatedCostUsd = rawCost ? Number(rawCost) : 0;
    if (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0) {
      res
        .status(400)
        .json({ error: "invalid_estimate", message: "x-gb-estimate-cost-usd must be >= 0" });
      return;
    }
    if (estimatedCostUsd === 0) {
      next();
      return;
    }

    const roleHeader = header(req, "x-gb-role") ?? "coder";
    const role: AgentRole = ROLES.has(roleHeader) ? (roleHeader as AgentRole) : "coder";
    try {
      guard.assertCanSpend({
        orgId: header(req, "x-gb-org-id") ?? "org-lab",
        runId: header(req, "x-gb-run-id") ?? "run-anonymous",
        requestId: header(req, "x-gb-request-id") ?? null,
        role,
        estimatedCostUsd,
        provider: header(req, "x-gb-provider") ?? "xai",
        model: header(req, "x-gb-model") ?? "grok-4",
      });
      next();
    } catch (err) {
      if (err instanceof CreditHardStopError) {
        res.status(402).json({
          error: err.code,
          reason: err.reason,
          scope: err.scope,
          role: err.role,
          usedUsd: err.usedUsd,
          capUsd: err.capUsd,
          escalation: err.escalation,
          message: err.message,
        });
        return;
      }
      next(err);
    }
  };
}
