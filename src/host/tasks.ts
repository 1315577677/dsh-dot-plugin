import { randomUUID } from 'node:crypto'
import { validateTaskDependencies } from './orchestrator/dependencies.js'
import type {
  DotState,
  DotTaskV2,
  TaskEvent,
  TaskEventType,
  TaskPriority,
  TaskStatus,
} from './types.js'

const TASK_STATUSES: readonly TaskStatus[] = [
  'inbox',
  'planned',
  'running',
  'coordinating',
  'waiting_user',
  'blocked',
  'done',
  'failed',
  'cancelled',
]

const TASK_PRIORITIES: readonly TaskPriority[] = ['low', 'normal', 'high']

const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  inbox: ['planned', 'blocked', 'cancelled'],
  planned: ['running', 'waiting_user', 'blocked', 'done', 'cancelled'],
  running: ['coordinating', 'waiting_user', 'blocked', 'failed', 'cancelled', 'done'],
  coordinating: ['running', 'waiting_user', 'blocked', 'failed', 'done', 'cancelled'],
  waiting_user: ['running', 'coordinating', 'blocked', 'failed', 'done', 'cancelled'],
  blocked: ['planned', 'running', 'coordinating', 'done', 'cancelled'],
  done: [],
  failed: ['planned', 'cancelled'],
  cancelled: [],
}

const EVENT_LIMIT = 200

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value)
}

export function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === 'string' && (TASK_PRIORITIES as readonly string[]).includes(value)
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to)
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`invalid task transition: ${from} -> ${to}`)
  }
}

export function makeTaskEvent(
  actor: TaskEvent['actor'],
  type: TaskEventType,
  summary: string,
  detail?: string,
  at = Date.now(),
): TaskEvent {
  return {
    id: `event_${randomUUID()}`,
    at,
    actor,
    type,
    summary,
    ...(detail === undefined ? {} : { detail }),
  }
}

export function makeTask(
  goal: string,
  nextStep = '',
  priority: TaskPriority = 'normal',
  now = Date.now(),
): DotTaskV2 {
  const title = goal.trim() || 'Untitled task'
  return {
    id: `task_${randomUUID()}`,
    title,
    request: title,
    status: 'planned',
    priority,
    createdAt: now,
    updatedAt: now,
    plan: 'Not started.',
    nextAction: nextStep.trim() || 'Decide the next concrete step.',
    dependsOn: [],
    artifacts: [],
    events: [makeTaskEvent('dot', 'created', `Task created: ${title}`, undefined, now)],
    proposalIds: [],
  }
}

export function appendTaskEvent(task: DotTaskV2, event: TaskEvent): void {
  task.events.push(event)
  if (task.events.length > EVENT_LIMIT) {
    task.events = task.events.slice(-EVENT_LIMIT)
  }
  task.updatedAt = Math.max(task.updatedAt, event.at)
}

export function hasTaskEvidence(task: DotTaskV2): boolean {
  return task.artifacts.length > 0 || Boolean(task.verifiedResult?.trim())
}

export function transitionTask(
  task: DotTaskV2,
  to: TaskStatus,
  summary: string,
  options: {
    actor?: TaskEvent['actor']
    detail?: string
    proposalId?: string
    artifactId?: string
    now?: number
  } = {},
): DotTaskV2 {
  assertTransition(task.status, to)
  if (to === 'done' && !hasTaskEvidence(task)) {
    throw new Error(`task ${task.id} cannot be done without an artifact or verifiedResult`)
  }
  const now = options.now ?? Date.now()
  task.status = to
  task.updatedAt = Math.max(task.updatedAt, now)
  appendTaskEvent(
    task,
    makeTaskEvent(options.actor ?? 'dot', 'status_changed', summary, options.detail, now),
  )
  const latest = task.events[task.events.length - 1]
  if (options.proposalId && latest) latest.proposalId = options.proposalId
  if (options.artifactId && latest) latest.artifactId = options.artifactId
  return task
}

/**
 * Validate the invariants the state store will never knowingly persist.
 * Malformed on-disk state is normalized first; this catches logic errors.
 */
export function validateState(state: DotState): void {
  const taskIds = new Set<string>()
  const workerIds = new Set<string>()
  const activeByTask = new Map<string, number>()

  for (const task of state.tasks) {
    if (taskIds.has(task.id)) throw new Error(`duplicate task id: ${task.id}`)
    taskIds.add(task.id)
    if (!isTaskStatus(task.status)) throw new Error(`invalid status for task ${task.id}`)
    if (!isTaskPriority(task.priority)) throw new Error(`invalid priority for task ${task.id}`)
    if (!task.title?.trim()) throw new Error(`task ${task.id} has no title`)
    if (task.status === 'done' && !hasTaskEvidence(task)) {
      throw new Error(`task ${task.id} is done without evidence`)
    }
  }

  validateTaskDependencies(state.tasks)

  for (const worker of state.workers) {
    if (workerIds.has(worker.id)) throw new Error(`duplicate worker id: ${worker.id}`)
    workerIds.add(worker.id)
    if (!taskIds.has(worker.taskId)) {
      throw new Error(`worker ${worker.id} references missing task ${worker.taskId}`)
    }
    if (worker.status === 'starting' || worker.status === 'running') {
      const count = (activeByTask.get(worker.taskId) ?? 0) + 1
      activeByTask.set(worker.taskId, count)
      if (count > 1) throw new Error(`task ${worker.taskId} has more than one active worker`)
    }
  }

  for (const task of state.tasks) {
    if (task.workerId && !workerIds.has(task.workerId)) {
      throw new Error(`task ${task.id} references missing worker ${task.workerId}`)
    }
  }

  if (state.focusedTaskId && !taskIds.has(state.focusedTaskId)) {
    throw new Error(`focused task does not exist: ${state.focusedTaskId}`)
  }
}
