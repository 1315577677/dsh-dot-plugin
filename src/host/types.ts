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
  | 'worker_stalled'
  | 'worker_restarted'
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


export interface SystemProactiveConfig {
  enabled?: boolean
  intervalMinutes?: number
  initialDelayMinutes?: number
  activeWindowHours?: number
  minConfidence?: number
  maxMessagesPerDay?: number
  minGapMinutes?: number
  quietHours?: string
  maxWorkspaces?: number
  focusWorkspaces?: number
  maxFilesPerWorkspace?: number
  maxSnippetChars?: number
  workspaceAllowlist?: string[]
  workspaceDenylist?: string[]
  provider?: string
  model?: string
}

export interface ResolvedSystemProactive {
  enabled: boolean
  intervalMinutes: number
  initialDelayMinutes: number
  activeWindowHours: number
  minConfidence: number
  maxMessagesPerDay: number
  minGapMinutes: number
  quietHours: string
  maxWorkspaces: number
  focusWorkspaces: number
  maxFilesPerWorkspace: number
  maxSnippetChars: number
  workspaceAllowlist: string[]
  workspaceDenylist: string[]
  provider: string
  model: string
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
  /** Grace period after a soft timeout before the session is re-probed. */
  workerStallConfirmMs?: number
  workerMaxTurns?: number
  workerStageMaxBytes?: number
  maxWorkers?: number
  stateDir?: string
  systemProactive?: SystemProactiveConfig
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
  workerStallConfirmMs: number
  workerMaxTurns: number
  workerStageMaxBytes: number
  maxWorkers: number
  stateDir: string
  systemProactive: ResolvedSystemProactive
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

export interface DotChatImage {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
}

export interface DotChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  at: number
  images?: DotChatImage[]
  /**
   * Monotonic per-conversation sequence number. It is the only ordering
   * authority for the chat; older messages may not have one.
   */
  seq?: number
  /** One dot_say call produces one batch; every message in it shares this id. */
  batchId?: string
  /** Chat message id this one quotes, when it is a quote reply. */
  replyTo?: string
  /** Flat, render-safe preview of the quoted message. */
  replyToPreview?: string
  /** Role of the quoted message, so the client can style the quote. */
  replyToRole?: 'user' | 'assistant'
  /**
   * User-receipt state: absent = sent, present = the Agent claimed this message
   * and started working on it (read). Kept after the reply arrives.
   */
  readAt?: number
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
  /** Absolute target workspace for this task. */
  workspace?: string
  /** Chat message that originated this task, used to quote replies about it. */
  sourceMessageId?: string
  /**
   * Ids of tasks that must be `done` before a worker may start this task.
   * Empty for independent tasks. Persisted with the rest of the task.
   */
  dependsOn: string[]
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

/**
 * Result of checking whether a worker Session still has a live Agent.
 * `stopped` is positive evidence (idle live Agent or no live Agent at all);
 * `unknown` never authorizes starting a replacement.
 */
export type WorkerLiveness = 'running' | 'stopped' | 'unknown'

export interface WorkerRecord {
  id: string
  taskId: string
  sessionId: string
  status: 'starting' | 'running' | 'stalled' | 'idle' | 'completed' | 'failed' | 'cancelled'
  brief: string
  startedAt: number
  updatedAt: number
  lastResult?: string
  lastError?: string
  turns: number
  /** When the soft turn timeout fired and the task was marked stalled. */
  stalledAt?: number
  /** Last liveness probe result for this Session. */
  lastLiveness?: WorkerLiveness
  /** When `lastLiveness` was last recorded. */
  livenessCheckedAt?: number
  /** When a probe positively confirmed the Session is no longer running. */
  stoppedAt?: number
  /** Worker id that replaced this one after a confirmed stop. */
  replacedBy?: string
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

export interface DotWorkerApproval {
  id: string
  taskId: string
  workerId: string
  toolName: string
  /** Raw DSH approval reason from the tool call; may be in any language and is never shown to the user as-is. */
  reason: string
  /** Dot's own review explanation, generated in the user's language; this is what the UI shows. */
  reviewReason?: string
  taskTitle: string
  workspace: string
  status: 'pending' | 'allowed' | 'rejected' | 'cancelled'
  createdAt: number
  decidedAt?: number
  decisionReason?: string
}

export interface DotStateV2 {
  version: 2
  dotSessionId?: string
  proposals: Proposal[]
  tasks: DotTaskV2[]
  workers: WorkerRecord[]
  chatMessages: DotChatMessage[]
  approvals: DotWorkerApproval[]
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
  /** True only from model-call start until the first reply message is committed. */
  chatReplying: boolean
  agentStatus?: string
  lastDeliveryError?: string
  sources: SourceConfig[]
  proposals: Proposal[]
  tasks: DotTaskV2[]
  workers: WorkerRecord[]
  chatMessages: DotChatMessage[]
  approvals: DotWorkerApproval[]
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
    approvals: [],
    triggers: [],
    pendingAuto: [],
  }
}
