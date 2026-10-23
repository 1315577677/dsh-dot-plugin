/**
 * Shared types for DSH Dot.
 *
 * The Dot is a real persistent Agent with its own Session. Its research phase
 * is read-only; proposals are durable records reviewed by the user; approved
 * execution is a separate scoped Agent turn with a tool allowlist.
 *
 * State v2 introduces the task-orchestrator model. The legacy v1 task shape is
 * migrated by state.ts and is not used by runtime code.
 */

export type RiskLevel = 'low' | 'medium' | 'high'
export type RuleDecision = 'allow' | 'ask' | 'deny'
export type ProposalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'executing'
  | 'executed'
  | 'failed'

export type TaskStatus =
  | 'inbox'
  | 'planned'
  | 'running'
  | 'coordinating'
  | 'waiting_user'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'cancelled'

export type TaskPriority = 'low' | 'normal' | 'high'

export type TaskEventType =
  | 'created'
  | 'status_changed'
  | 'worker_started'
  | 'worker_progress'
  | 'worker_completed'
  | 'worker_failed'
  | 'worker_cancelled'
  | 'artifact_attached'
  | 'focus_changed'
  | 'decision_requested'
  | 'approved'
  | 'rejected'
  | 'executed'
  | 'blocked'
  | 'resumed'
  | 'completed'
  | 'cancelled'

export interface RuleConfig {
  action_pattern: string
  decision: RuleDecision
}

export interface SourceConfig {
  id: string
  kind: 'directory' | 'url' | 'mcp'
  label: string
  path?: string
  url?: string
  tools?: string[]
  enabled?: boolean
}

export interface DshDotConfig {
  enabled?: boolean
  orchestrator?: boolean
  initialDelayMs?: number
  researchIntervalMs?: number
  sources?: SourceConfig[]
  readOnlyTools?: string[]
  executionTools?: string[]
  reviewModel?: string
  reviewProvider?: string
  reviewTimeoutMs?: number
  rules?: RuleConfig[]
  autoApproveLowRisk?: boolean
  dotWorkspace?: string
  maxProposalsPerRound?: number
  researchPrompt?: string
  agentPreset?: string
  workerTimeoutMs?: number
  workerMaxTurns?: number
  workerStageMaxBytes?: number
  maxWorkers?: number
  stateDir?: string
}

export interface ResolvedConfig {
  enabled: boolean
  orchestrator: boolean
  initialDelayMs: number
  researchIntervalMs: number
  sources: SourceConfig[]
  readOnlyTools: string[]
  executionTools: string[]
  reviewModel: string
  reviewProvider: string
  reviewTimeoutMs: number
  rules: RuleConfig[]
  autoApproveLowRisk: boolean
  dotWorkspace: string
  maxProposalsPerRound: number
  researchPrompt: string
  agentPreset: string
  workerTimeoutMs: number
  workerMaxTurns: number
  workerStageMaxBytes: number
  maxWorkers: number
  stateDir: string
}

export interface Proposal {
  id: string
  title: string
  description: string
  proposedAction: string
  actionType: string
  source: string
  evidence: string
  risk: RiskLevel
  riskReason: string
  decision: RuleDecision
  status: ProposalStatus
  executionTools: string[]
  executionInstruction: string
  createdAt: number
  updatedAt: number
  decidedAt?: number
  executedAt?: number
  result?: string
  error?: string
  /** Task this proposal belongs to, when it was produced for a task. */
  taskId?: string
  /** Worker that prepared the proposal, when known. */
  workerId?: string
}

export interface DotChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  at: number
  /** Chat message id this one quotes, when it is a quote reply. */
  replyTo?: string
  /** Flat, render-safe preview of the quoted message. */
  replyToPreview?: string
  /** Role of the quoted message, so the client can style the quote. */
  replyToRole?: 'user' | 'assistant'
}

export interface TaskArtifact {
  id: string
  title: string
  path?: string
  url?: string
  kind: 'file' | 'link' | 'report' | 'draft'
  createdAt: number
}

export interface TaskEvent {
  id: string
  at: number
  actor: 'dot' | 'worker' | 'user' | 'system'
  type: TaskEventType
  summary: string
  detail?: string
  proposalId?: string
  artifactId?: string
}

export interface DotTaskV2 {
  id: string
  title: string
  request: string
  status: TaskStatus
  priority: TaskPriority
  createdAt: number
  updatedAt: number
  workerId?: string
  plan: string
  nextAction: string
  waitingFor?: string
  blockedReason?: string
  artifacts: TaskArtifact[]
  events: TaskEvent[]
  proposalIds: string[]
  /** Evidence that justifies a `done` status without an artifact. */
  verifiedResult?: string
  /** A task imported from v1 that has not been adopted by the supervisor. */
  legacy?: true
}

/** @deprecated use DotTaskV2. */
export type DotTask = DotTaskV2

export interface WorkerRecord {
  id: string
  taskId: string
  sessionId: string
  status: 'starting' | 'running' | 'idle' | 'completed' | 'failed' | 'cancelled'
  brief: string
  startedAt: number
  updatedAt: number
  lastResult?: string
  lastError?: string
  turns: number
}

export interface DotTrigger {
  id: string
  source: string
  condition: string
  instruction: string
  createdAt: number
  lastFiredAt?: number
  enabled: boolean
}

export interface DotStateV2 {
  version: 2
  dotSessionId?: string
  proposals: Proposal[]
  tasks: DotTaskV2[]
  workers: WorkerRecord[]
  chatMessages: DotChatMessage[]
  focusedTaskId?: string
  triggers: DotTrigger[]
  lastResearchAt?: number
  lastResearchCompletedAt?: number
  lastError?: string
  /** Proposal ids approved by policy that await an idle Agent. */
  pendingAuto: string[]
  /** Proposal currently executing in an Agent turn. */
  executingId?: string
}

export type DotState = DotStateV2

export interface ScheduleView {
  id: string
  title: string
  kind: string
  detail: string
  scheduledAt?: string
}

export interface ClientState {
  ok: true
  version: 2
  enabled: boolean
  dotSessionId?: string
  dotStatus: 'starting' | 'idle' | 'running' | 'error'
  agentStatus?: string
  lastDeliveryError?: string
  sources: SourceConfig[]
  proposals: Proposal[]
  tasks: DotTaskV2[]
  workers: WorkerRecord[]
  chatMessages: DotChatMessage[]
  focusedTaskId?: string
  triggers: DotTrigger[]
  schedules: ScheduleView[]
  lastResearchAt?: number
  lastResearchCompletedAt?: number
  lastError?: string
  executionTools: string[]
}

export interface ProposalInput {
  taskId?: string
  workerId?: string
  title: string
  description: string
  proposedAction: string
  actionType: string
  source: string
  evidence: string
  executionTools: string[]
  executionInstruction: string
}

export interface RiskReview {
  risk: RiskLevel
  reason: string
}

export interface ResearchResult {
  started: boolean
  reason: string
}

export const DEFAULT_RULES: RuleConfig[] = [
  {
    action_pattern: '(^|_)(send|email|invoice|publish|share|pay|purchase|transfer|delete|remove|invite)',
    decision: 'ask',
  },
  {
    action_pattern: '^(read|analyze|draft|prepare|summari[sz]e|investigate)',
    decision: 'allow',
  },
]

export const DEFAULT_READ_ONLY_TOOLS = ['read', 'glob', 'grep', 'web_search', 'web_fetch']
export const DEFAULT_EXECUTION_TOOLS = ['write', 'edit']

export function emptyState(): DotState {
  return {
    version: 2,
    proposals: [],
    tasks: [],
    workers: [],
    chatMessages: [],
    triggers: [],
    pendingAuto: [],
  }
}
