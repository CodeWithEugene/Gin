/** Wire shapes mirrored from the gateway RPC surface. */

export interface AgentInfo {
  id: string;
  name: string;
  modelConfig: { primary: string; fallbacks: string[] };
  workspacePath: string;
  sandboxMode: string;
}

export interface SessionInfo {
  id: string;
  agentId: string;
  channelId?: string;
  peerRef: string;
  status: string;
  lastActiveAt: number;
}

export interface TraceSummary {
  traceId: string;
  turnId?: string;
  sessionId?: string;
  startTs: number;
  endTs: number;
  eventCount: number;
  modelCalls: number;
  toolCalls: number;
  costUsd: number;
  status: "running" | "succeeded" | "failed" | "budget_terminated";
}

export interface TraceEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  ts: number;
}

export interface BudgetStatus {
  id: string;
  scope: string;
  scopeRef: string;
  limitUsd: number;
  window: string;
  action: string;
  spentUsd: number;
  remainingUsd: number;
}

export interface ApprovalRecord {
  id: string;
  action: string;
  params: unknown;
  riskLevel: string;
  status: string;
  requestedAt: number;
  decidedBy?: string;
  reason?: string;
}

export interface ScheduleJob {
  id: string;
  name: string;
  cron: string;
  action: { kind: "message"; text: string } | { kind: "workflow"; workflow: string };
  enabled: boolean;
  nextRunAt?: number;
  lastRunAt?: number;
  lastStatus?: string;
}

export interface GatewayStatus {
  name: string;
  version: string;
  uptimeMs: number;
  eventsBuffered: number;
  agents?: number;
  defaultAgent?: string;
}

export interface BusEvent {
  id: string;
  ts: number;
  type: string;
  payload: unknown;
}
