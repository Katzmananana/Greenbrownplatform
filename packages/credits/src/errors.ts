import type { AgentRole, CreditScope } from "@gb/shared";

export class CreditHardStopError extends Error {
  readonly code = "credit_hard_stop" as const;
  readonly reason: "credit_hard_stop" | "budget" = "credit_hard_stop";
  readonly scope: CreditScope;
  readonly role?: AgentRole;
  readonly usedUsd: number;
  readonly capUsd: number;
  readonly escalation = "NEEDS_HUMAN" as const;

  constructor(opts: {
    scope: CreditScope;
    usedUsd: number;
    capUsd: number;
    role?: AgentRole;
    message?: string;
  }) {
    const suffix = opts.role ? ` role=${opts.role}` : "";
    super(
      opts.message ??
        `Credit hard stop: ${opts.scope} cap exceeded (${opts.usedUsd.toFixed(4)} > ${opts.capUsd.toFixed(4)}${suffix})`,
    );
    this.name = "CreditHardStopError";
    this.scope = opts.scope;
    this.usedUsd = opts.usedUsd;
    this.capUsd = opts.capUsd;
    this.role = opts.role;
  }
}
