import type { AgentRole, CreditLedgerEntry } from "@gb/shared";

export interface CreditLedgerStore {
  append(entry: CreditLedgerEntry): void;
  sumOrg(orgId: string): number;
  sumRun(runId: string): number;
  sumRole(orgId: string, runId: string, role: AgentRole | string): number;
  list(): readonly CreditLedgerEntry[];
}

export class InMemoryCreditLedger implements CreditLedgerStore {
  private readonly entries: CreditLedgerEntry[] = [];

  append(entry: CreditLedgerEntry): void {
    this.entries.push(entry);
  }

  sumOrg(orgId: string): number {
    return sum(this.entries.filter((e) => e.orgId === orgId).map((e) => e.costUsd));
  }

  sumRun(runId: string): number {
    return sum(this.entries.filter((e) => e.runId === runId).map((e) => e.costUsd));
  }

  sumRole(orgId: string, runId: string, role: AgentRole | string): number {
    return sum(
      this.entries
        .filter((e) => e.orgId === orgId && e.runId === runId && e.role === role)
        .map((e) => e.costUsd),
    );
  }

  list(): readonly CreditLedgerEntry[] {
    return this.entries;
  }
}

function sum(values: number[]): number {
  return values.reduce((acc, n) => acc + n, 0);
}
