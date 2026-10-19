/**
 * Shared types for the DSH-native DSH Dot.
 *
 * The Dot is a real persistent Agent with its own Session. Its research phase
 * is read-only; proposals are durable records reviewed by the user; approved
 * execution is a separate scoped Agent turn with a tool allowlist.
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
  stateDir?: string
}

export interface ResolvedConfig {
  enabled: boolean
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
}

export interface DotTask {
  id: string
  goal: string
  progress: string
  nextStep: string
  createdAt: number
  updatedAt: number
  status: 'active' | 'done'
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

export interface DotState {
  version: 1
  dotSessionId?: string
  proposals: Proposal[]
  tasks: DotTask[]
  triggers: DotTrigger[]
  lastResearchAt?: number
  lastResearchCompletedAt?: number
  lastError?: string
  /** Proposal ids approved by policy that await an idle Agent. */
  pendingAuto: string[]
  /** Proposal currently executing in an Agent turn. */
  executingId?: string
}

export interface ScheduleView {
  id: string
  title: string
  kind: string
  detail: string
  scheduledAt?: string
}

export interface ClientState {
  ok: true
  version: 1
  enabled: boolean
  dotSessionId?: string
  dotStatus: 'starting' | 'idle' | 'running' | 'error'
  sources: SourceConfig[]
  proposals: Proposal[]
  tasks: DotTask[]
  triggers: DotTrigger[]
  schedules: ScheduleView[]
  lastResearchAt?: number
  lastResearchCompletedAt?: number
  lastError?: string
  executionTools: string[]
}

export interface ProposalInput {
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
    version: 1,
    proposals: [],
    tasks: [],
    triggers: [],
    pendingAuto: [],
  }
}
