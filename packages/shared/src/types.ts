export type AgentRole = "planner" | "coder" | "reviewer" | "fixer" | "reporter";

export type Checkpoint = "CP1" | "CP2" | "CP3";

export type RunStatus =
  | "active"
  | "succeeded"
  | "escalated"
  | "needs_human"
  | "dead_letter"
  | "cancelled"
  | "live";

export type ProjectKind = "green" | "brown";

export interface ModelRef {
  provider: string;
  model: string;
}

export interface OrgConfig {
  id: string;
  orgId: string;
  maxFixIterations: number;
  maxAllowedIterations: number;
  /** Organization-wide spend ceiling in USD. Hard stop. */
  maxCostUsd: number;
  /** Per-run spend ceiling in USD. Hard stop. */
  maxCostUsdPerRun: number;
  /** Per-agent-role spend ceiling in USD. Hard stop. */
  perRoleBudgetUsd: Partial<Record<AgentRole, number>>;
  /** Alert when spend reaches this percent of a cap. Default 80. */
  creditAlertPct: number;
  maxWallClockSeconds: number;
  timeouts: Record<string, number>;
  notify: {
    email?: string[];
    slackWebhookUrlPresent?: boolean;
  };
  codingAgent: string;
  models: Partial<Record<AgentRole | "intake" | "fallback", ModelRef>>;
  allowSelfApproval: boolean;
  protectedPaths: string[];
  requiredChecks: string[];
  requireProdApproval: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

export interface Run {
  id: string;
  requestId: string;
  planId: string | null;
  branch: string;
  agentKind: string;
  agentRunId: string | null;
  iteration: number;
  status: RunStatus;
  deadlineAt: string | null;
  leaseUntil: string | null;
  heartbeatAt: string | null;
  version: number;
  startedAt: string;
  endedAt: string | null;
}

export type GateName =
  | "lint"
  | "typecheck"
  | "unit"
  | "functional"
  | "e2e"
  | "reviewer"
  | "acceptance"
  | "sast"
  | "load_pr"
  | "load_staging"
  | "fix_loop";

export type GateStatus = "queued" | "in_progress" | "completed";

export type GateConclusion =
  | "success"
  | "failure"
  | "timed_out"
  | "cancelled"
  | "neutral"
  | "needs_human";

export interface GateResult {
  name: GateName | string;
  status: GateStatus;
  conclusion: GateConclusion;
  passed: boolean;
  message: string;
  reportUri?: string;
}

export interface CreditLedgerEntry {
  id: string;
  orgId: string;
  requestId: string | null;
  runId: string | null;
  role: AgentRole | string;
  provider: string;
  model: string;
  inTokens: number;
  outTokens: number;
  costUsd: number;
  reason: string;
  createdAt: string;
}

export type CreditScope = "org" | "run" | "role";

export interface CreditAlert {
  type: "credit_alert";
  scope: CreditScope;
  role?: AgentRole;
  usedUsd: number;
  capUsd: number;
  pct: number;
  alertPct: number;
  orgId: string;
  runId?: string;
}

export type ApprovalDecision = "approved" | "changes_requested";

export interface Approval {
  id: string;
  requestId: string;
  checkpoint: Checkpoint;
  subjectHash: string;
  decision: ApprovalDecision;
  comment: string | null;
  userId: string;
  at: string;
}

export interface Deployment {
  id: string;
  runId: string | null;
  requestId: string | null;
  environment: "lab" | "staging" | "production";
  commitSha: string;
  railwayDeploymentId: string | null;
  previousDeploymentId: string | null;
  status: "pending" | "promoting" | "live" | "failed" | "rolled_back";
  healthStatus: "unknown" | "ok" | "unhealthy";
  rolledBack: boolean;
  createdAt: string;
}
