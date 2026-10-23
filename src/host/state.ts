import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  emptyState,
  type DotState,
  type DotTaskV2,
  type Proposal,
  type TaskArtifact,
  type TaskEvent,
  type DotTrigger,
  type DotChatMessage,
  type WorkerRecord,
} from './types.js'
import {
  isTaskPriority,
  isTaskStatus,
  makeTaskEvent,
  validateState,
} from './tasks.js'

type Log = (message: string, ...args: unknown[]) => void

const STATE_FILE = 'state.json'
const V1_BACKUP_FILE = 'state.v1.backup.json'
const MAX_PROPOSALS = 120
const MAX_TASKS = 50

/**
 * Atomic JSON store for the Dot's durable control-plane state.
 *
 * The Agent's Session log remains the source of truth for conversation and
 * tool outcomes. This file stores plugin-owned records: the Dot Session
 * identity, proposals, tasks, workers, triggers, and the last research
 * bookkeeping.
 */
export class StateStore {
  readonly dataDir: string
  state: DotState = emptyState()

  private loaded?: Promise<void>
  private writeChain: Promise<void> = Promise.resolve()

  constructor(dataDir: string, private readonly log: Log = () => {}) {
    this.dataDir = dataDir
  }

  get file(): string {
    return path.join(this.dataDir, STATE_FILE)
  }

  get v1BackupFile(): string {
    return path.join(this.dataDir, V1_BACKUP_FILE)
  }

  ensureLoaded(): Promise<void> {
    this.loaded ??= this.load()
    return this.loaded
  }

  private async load(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true })
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Record<string, any>
      if (parsed?.version === 1) {
        await this.backupV1(raw)
        this.state = normalizeV1(parsed)
      } else if (parsed?.version === 2) {
        this.state = normalizeV2(parsed)
      } else {
        this.state = emptyState()
      }
      validateState(this.state)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log('dsh-dot: state load failed; starting empty', error)
      }
      this.state = emptyState()
    }
  }

  private async backupV1(raw: string): Promise<void> {
    try {
      await fs.writeFile(this.v1BackupFile, raw, { encoding: 'utf8', flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        this.log('dsh-dot: could not write v1 state backup', error)
      }
    }
  }

  async mutate(fn: (state: DotState) => void): Promise<DotState> {
    await this.ensureLoaded()
    fn(this.state)
    validateState(this.state)
    this.trim()
    await this.persist()
    return this.state
  }

  async persist(): Promise<void> {
    await this.ensureLoaded()
    const payload = `${JSON.stringify(this.state, null, 2)}\n`
    const temp = path.join(this.dataDir, `.state-${process.pid}-${Date.now()}.json`)
    this.writeChain = this.writeChain
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(this.dataDir, { recursive: true })
        await fs.writeFile(temp, payload, 'utf8')
        await fs.rename(temp, this.file)
      })
      .catch(async (error) => {
        this.log('dsh-dot: state write failed', error)
        await fs.unlink(temp).catch(() => {})
      })
    return this.writeChain
  }

  async flush(): Promise<void> {
    await this.writeChain
  }

  private trim(): void {
    if (this.state.proposals.length > MAX_PROPOSALS) {
      const protectedIds = new Set(
        this.state.proposals
          .filter((proposal) => proposal.status === 'pending' || proposal.status === 'executing')
          .map((proposal) => proposal.id),
      )
      const protectedProposals = this.state.proposals.filter((proposal) => protectedIds.has(proposal.id))
      const remaining = this.state.proposals.filter((proposal) => !protectedIds.has(proposal.id))
      this.state.proposals = [...protectedProposals, ...remaining].slice(0, MAX_PROPOSALS)
    }

    if (this.state.chatMessages.length > 200) {
      this.state.chatMessages = this.state.chatMessages.slice(-200)
    }

    if (this.state.tasks.length > MAX_TASKS) {
      const focused = this.state.tasks.find((task) => task.id === this.state.focusedTaskId)
      const kept = this.state.tasks.slice(0, MAX_TASKS)
      if (focused && !kept.some((task) => task.id === focused.id)) kept[kept.length - 1] = focused
      const keptIds = new Set(kept.map((task) => task.id))
      this.state.tasks = kept
      this.state.workers = this.state.workers.filter((worker) => keptIds.has(worker.taskId))
      if (this.state.focusedTaskId && !keptIds.has(this.state.focusedTaskId)) {
        this.state.focusedTaskId = undefined
      }
    }
  }
}

function normalizeV1(parsed: Record<string, any>): DotState {
  const state = emptyState()
  if (typeof parsed.dotSessionId === 'string') state.dotSessionId = parsed.dotSessionId
  if (Array.isArray(parsed.proposals)) {
    state.proposals = parsed.proposals.filter(isProposal).map(normalizeProposal)
  }
  if (Array.isArray(parsed.tasks)) {
    state.tasks = parsed.tasks.filter(isLegacyTask).map(migrateLegacyTask)
  }
  if (Array.isArray(parsed.triggers)) {
    state.triggers = parsed.triggers.filter(isTrigger).map(normalizeTrigger)
  }
  if (Number.isFinite(parsed.lastResearchAt)) state.lastResearchAt = Number(parsed.lastResearchAt)
  if (Number.isFinite(parsed.lastResearchCompletedAt)) {
    state.lastResearchCompletedAt = Number(parsed.lastResearchCompletedAt)
  }
  if (typeof parsed.lastError === 'string') state.lastError = parsed.lastError
  if (Array.isArray(parsed.pendingAuto)) {
    state.pendingAuto = parsed.pendingAuto.filter((id): id is string => typeof id === 'string')
  }
  if (typeof parsed.executingId === 'string') state.executingId = parsed.executingId
  const firstOpen = state.tasks.find((task) => task.status !== 'done' && task.status !== 'cancelled')
  state.focusedTaskId = firstOpen?.id
  return state
}

function normalizeV2(parsed: Record<string, any>): DotState {
  const state = emptyState()
  if (typeof parsed.dotSessionId === 'string') state.dotSessionId = parsed.dotSessionId
  if (Array.isArray(parsed.proposals)) {
    state.proposals = parsed.proposals.filter(isProposal).map(normalizeProposal)
  }
  if (Array.isArray(parsed.tasks)) {
    state.tasks = parsed.tasks.filter(isV2Task).map(normalizeTask)
  }
  if (Array.isArray(parsed.workers)) {
    state.workers = parsed.workers.filter(isWorker).map(normalizeWorker)
  }
  if (Array.isArray(parsed.chatMessages)) {
    state.chatMessages = parsed.chatMessages
      .filter(isChatMessage)
      .map((message) => ({ ...message, at: Number(message.at) || Date.now() }))
      .slice(-200)
  }
  if (Array.isArray(parsed.triggers)) {
    state.triggers = parsed.triggers.filter(isTrigger).map(normalizeTrigger)
  }
  if (Number.isFinite(parsed.lastResearchAt)) state.lastResearchAt = Number(parsed.lastResearchAt)
  if (Number.isFinite(parsed.lastResearchCompletedAt)) {
    state.lastResearchCompletedAt = Number(parsed.lastResearchCompletedAt)
  }
  if (typeof parsed.lastError === 'string') state.lastError = parsed.lastError
  if (Array.isArray(parsed.pendingAuto)) {
    state.pendingAuto = parsed.pendingAuto.filter((id): id is string => typeof id === 'string')
  }
  if (typeof parsed.executingId === 'string') state.executingId = parsed.executingId

  const taskIds = new Set(state.tasks.map((task) => task.id))
  state.workers = state.workers.filter((worker) => taskIds.has(worker.taskId))
  state.tasks = state.tasks.map((task) => {
    if (task.workerId && !state.workers.some((worker) => worker.id === task.workerId && worker.taskId === task.id)) {
      return { ...task, workerId: undefined }
    }
    return task
  })
  if (typeof parsed.focusedTaskId === 'string' && taskIds.has(parsed.focusedTaskId)) {
    state.focusedTaskId = parsed.focusedTaskId
  }
  return state
}

function normalizeProposal(value: unknown): Proposal {
  const proposal = value as Proposal
  return {
    ...proposal,
    executionTools: Array.isArray(proposal.executionTools) ? proposal.executionTools : [],
    taskId: typeof proposal.taskId === 'string' ? proposal.taskId : undefined,
    workerId: typeof proposal.workerId === 'string' ? proposal.workerId : undefined,
  }
}

function migrateLegacyTask(value: unknown): DotTaskV2 {
  const legacy = value as {
    id: string
    goal: string
    progress?: string
    nextStep?: string
    createdAt?: number
    updatedAt?: number
    status?: 'active' | 'done'
  }
  const now = Number(legacy.updatedAt) || Number(legacy.createdAt) || Date.now()
  const done = legacy.status === 'done'
  const title = legacy.goal.trim() || 'Legacy task'
  const progress = typeof legacy.progress === 'string' ? legacy.progress : 'Imported from v1.'
  return {
    id: legacy.id,
    title,
    request: title,
    status: done ? 'done' : 'blocked',
    priority: 'normal',
    createdAt: Number(legacy.createdAt) || now,
    updatedAt: now,
    plan: progress,
    nextAction: typeof legacy.nextStep === 'string' && legacy.nextStep.trim()
      ? legacy.nextStep
      : 'Adopt this legacy task into the task orchestrator.',
    ...(done
      ? { verifiedResult: progress.trim() || 'Imported legacy done task.' }
      : { blockedReason: 'legacy_task_needs_adoption' }),
    artifacts: [],
    events: [
      makeTaskEvent('system', 'created', `Legacy task imported: ${title}`, undefined, now),
      makeTaskEvent(
        'system',
        done ? 'completed' : 'blocked',
        done ? 'Legacy task imported as done.' : 'Legacy task needs supervisor adoption.',
        undefined,
        now,
      ),
    ],
    proposalIds: [],
    legacy: true,
  }
}

function normalizeTask(value: unknown): DotTaskV2 {
  const task = value as Partial<DotTaskV2> & { goal?: string; progress?: string; nextStep?: string }
  const now = Number(task.updatedAt) || Number(task.createdAt) || Date.now()
  const title = (task.title ?? task.goal ?? 'Untitled task').trim() || 'Untitled task'
  const status = isTaskStatus(task.status) ? task.status : 'planned'
  const priority = isTaskPriority(task.priority) ? task.priority : 'normal'
  const artifacts = Array.isArray(task.artifacts)
    ? task.artifacts.filter(isArtifact).map(normalizeArtifact)
    : []
  const events = Array.isArray(task.events) ? task.events.filter(isEvent).map(normalizeEvent) : []
  const verifiedResult = typeof task.verifiedResult === 'string' ? task.verifiedResult : undefined
  const doneWithoutEvidence = status === 'done' && artifacts.length === 0 && !verifiedResult?.trim()
  return {
    id: String(task.id ?? `task_${now}`),
    title,
    request: typeof task.request === 'string' && task.request.trim() ? task.request : title,
    status,
    priority,
    createdAt: Number(task.createdAt) || now,
    updatedAt: now,
    ...(typeof task.workerId === 'string' ? { workerId: task.workerId } : {}),
    plan: typeof task.plan === 'string' ? task.plan : typeof task.progress === 'string' ? task.progress : 'Not started.',
    nextAction: typeof task.nextAction === 'string'
      ? task.nextAction
      : typeof task.nextStep === 'string'
        ? task.nextStep
        : 'Decide the next concrete step.',
    ...(typeof task.waitingFor === 'string' ? { waitingFor: task.waitingFor } : {}),
    ...(typeof task.blockedReason === 'string' ? { blockedReason: task.blockedReason } : {}),
    artifacts,
    events: events.length > 0
      ? events
      : [makeTaskEvent('system', 'created', `Task loaded: ${title}`, undefined, now)],
    proposalIds: Array.isArray(task.proposalIds)
      ? task.proposalIds.filter((id): id is string => typeof id === 'string')
      : [],
    ...(doneWithoutEvidence ? { verifiedResult: 'Imported done task; verify evidence.' } : verifiedResult ? { verifiedResult } : {}),
    ...(task.legacy === true ? { legacy: true as const } : {}),
  }
}

function normalizeWorker(value: unknown): WorkerRecord {
  const worker = value as WorkerRecord
  return {
    ...worker,
    status: ['starting', 'running', 'idle', 'completed', 'failed', 'cancelled'].includes(worker.status)
      ? worker.status
      : 'idle',
    turns: Number.isFinite(worker.turns) ? Number(worker.turns) : 0,
  }
}

function normalizeArtifact(value: unknown): TaskArtifact {
  const artifact = value as TaskArtifact
  return {
    ...artifact,
    kind: ['file', 'link', 'report', 'draft'].includes(artifact.kind) ? artifact.kind : 'file',
    createdAt: Number(artifact.createdAt) || Date.now(),
  }
}

function normalizeEvent(value: unknown): TaskEvent {
  const event = value as TaskEvent
  return {
    ...event,
    at: Number(event.at) || Date.now(),
  }
}

function normalizeTrigger(value: unknown): DotTrigger {
  return value as DotTrigger
}

function isChatMessage(value: unknown): value is DotChatMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  return (
    typeof message.id === 'string' &&
    (message.role === 'user' || message.role === 'assistant') &&
    typeof message.text === 'string'
  )
}

function isProposal(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const proposal = value as Record<string, unknown>
  return (
    typeof proposal.id === 'string' &&
    typeof proposal.title === 'string' &&
    typeof proposal.status === 'string' &&
    typeof proposal.risk === 'string'
  )
}

function isLegacyTask(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const task = value as Record<string, unknown>
  return typeof task.id === 'string' && typeof task.goal === 'string' && typeof task.title !== 'string'
}

function isV2Task(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const task = value as Record<string, unknown>
  return typeof task.id === 'string' && (typeof task.title === 'string' || typeof task.goal === 'string')
}

function isWorker(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const worker = value as Record<string, unknown>
  return (
    typeof worker.id === 'string' &&
    typeof worker.taskId === 'string' &&
    typeof worker.sessionId === 'string'
  )
}

function isArtifact(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const artifact = value as Record<string, unknown>
  return typeof artifact.id === 'string' && typeof artifact.title === 'string'
}

function isEvent(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const event = value as Record<string, unknown>
  return typeof event.id === 'string' && typeof event.summary === 'string' && typeof event.type === 'string'
}

function isTrigger(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const trigger = value as Record<string, unknown>
  return typeof trigger.id === 'string' && typeof trigger.source === 'string'
}
