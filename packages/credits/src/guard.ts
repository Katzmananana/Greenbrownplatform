import type { AgentRole, CreditAlert, CreditLedgerEntry, CreditScope, OrgConfig } from "@gb/shared";
import { CreditHardStopError } from "./errors.js";
import type { CreditLedgerStore } from "./ledger.js";

export interface SpendRequest {
  orgId: string;
  runId: string;
  requestId?: string | null;
  role: AgentRole;
  estimatedCostUsd: number;
  provider?: string;
  model?: string;
}

export type AlertHandler = (alert: CreditAlert) => void;

/**
 * Server-side credit enforcement. Call `assertCanSpend` immediately before
 * any ModelProvider.complete() — an agent cannot bypass this if every LLM
 * call goes through `completeWithCreditGuard`.
 */
export class CreditGuard {
  constructor(
    private readonly config: OrgConfig,
    private readonly ledger: CreditLedgerStore,
    private readonly onAlert: AlertHandler = () => undefined,
  ) {}

  assertCanSpend(req: SpendRequest): void {
    if (req.estimatedCostUsd < 0) {
      throw new RangeError("estimatedCostUsd must be >= 0");
    }

    const currentOrg = this.ledger.sumOrg(req.orgId);
    const currentRun = this.ledger.sumRun(req.runId);
    const currentRole = this.ledger.sumRole(req.orgId, req.runId, req.role);
    const nextOrg = currentOrg + req.estimatedCostUsd;
    const nextRun = currentRun + req.estimatedCostUsd;
    const nextRole = currentRole + req.estimatedCostUsd;

    this.maybeAlert({
      scope: "org",
      current: currentOrg,
      next: nextOrg,
      cap: this.config.maxCostUsd,
      orgId: req.orgId,
    });
    this.maybeAlert({
      scope: "run",
      current: currentRun,
      next: nextRun,
      cap: this.config.maxCostUsdPerRun,
      orgId: req.orgId,
      runId: req.runId,
    });
    const roleCap = this.config.perRoleBudgetUsd[req.role];
    if (roleCap != null) {
      this.maybeAlert({
        scope: "role",
        current: currentRole,
        next: nextRole,
        cap: roleCap,
        orgId: req.orgId,
        runId: req.runId,
        role: req.role,
      });
    }

    if (nextOrg > this.config.maxCostUsd) {
      throw new CreditHardStopError({
        scope: "org",
        usedUsd: nextOrg,
        capUsd: this.config.maxCostUsd,
      });
    }
    if (nextRun > this.config.maxCostUsdPerRun) {
      throw new CreditHardStopError({
        scope: "run",
        usedUsd: nextRun,
        capUsd: this.config.maxCostUsdPerRun,
      });
    }
    if (roleCap != null && nextRole > roleCap) {
      throw new CreditHardStopError({
        scope: "role",
        usedUsd: nextRole,
        capUsd: roleCap,
        role: req.role,
      });
    }
  }

  recordSpend(
    req: SpendRequest & { inTokens?: number; outTokens?: number; reason?: string },
  ): CreditLedgerEntry {
    const entry: CreditLedgerEntry = {
      id: `led_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      orgId: req.orgId,
      requestId: req.requestId ?? null,
      runId: req.runId,
      role: req.role,
      provider: req.provider ?? "unknown",
      model: req.model ?? "unknown",
      inTokens: req.inTokens ?? 0,
      outTokens: req.outTokens ?? 0,
      costUsd: req.estimatedCostUsd,
      reason: req.reason ?? "llm_complete",
      createdAt: new Date().toISOString(),
    };
    this.ledger.append(entry);
    return entry;
  }

  /**
   * The only supported path to an LLM completion. Hard-stop throws before
   * `complete` runs, so a caller cannot spend after a cap is hit.
   */
  async completeWithCreditGuard<T>(
    req: SpendRequest,
    complete: () => Promise<T>,
    usage?: { inTokens?: number; outTokens?: number },
  ): Promise<T> {
    this.assertCanSpend(req);
    const result = await complete();
    this.recordSpend({ ...req, ...usage });
    return result;
  }

  private maybeAlert(args: {
    scope: CreditScope;
    current: number;
    next: number;
    cap: number;
    orgId: string;
    runId?: string;
    role?: AgentRole;
  }): void {
    if (args.cap <= 0) return;
    const threshold = (args.cap * this.config.creditAlertPct) / 100;
    if (args.next >= threshold && args.current < threshold) {
      const alert: CreditAlert = {
        type: "credit_alert",
        scope: args.scope,
        role: args.role,
        usedUsd: args.next,
        capUsd: args.cap,
        pct: (args.next / args.cap) * 100,
        alertPct: this.config.creditAlertPct,
        orgId: args.orgId,
        runId: args.runId,
      };
      this.onAlert(alert);
    }
  }
}
