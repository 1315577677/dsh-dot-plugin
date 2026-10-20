import { StateStore } from '../state.js'
import type { DotTaskV2, TaskPriority } from '../types.js'
import type { TaskService } from './task-service.js'

type Log = (message: string, ...args: unknown[]) => void

export interface WorkerSpawner {
  spawn(taskId: string, brief: string): Promise<unknown>
}

export interface CoordinatorOptions {
  store: StateStore
  tasks: TaskService
  workers: WorkerSpawner
  maxWorkers: number
  log?: Log
}

export interface AssignResult {
  taskId: string
  queued: boolean
  started: boolean
}

/**
 * The only place that decides which task gets a worker slot. Focus is a
 * priority, not ownership: it never cancels another task.
 */
export class Coordinator {
  private readonly store: StateStore
  private readonly tasks: TaskService
  private readonly workers: WorkerSpawner
  private readonly maxWorkers: number
  private readonly log: Log
  private readonly requests = new Map<string, string>()
  private pumping?: Promise<void>
  private repump = false

  constructor(options: CoordinatorOptions) {
    this.store = options.store
    this.tasks = options.tasks
    this.workers = options.workers
    this.maxWorkers = Math.max(1, options.maxWorkers)
    this.log = options.log ?? (() => {})
  }

  async request(taskId: string, brief: string): Promise<AssignResult> {
    await this.store.ensureLoaded()
    const task = this.findTask(taskId)
    if (!['planned', 'blocked', 'running'].includes(task.status)) {
      throw new Error(`task_not_assignable: ${task.status}`)
    }
    if (this.activeWorkerForTask(taskId)) throw new Error('task_already_has_active_worker')
    this.requests.set(taskId, brief.trim() || 'Work on the task.')
    await this.pump()
    return {
      taskId,
      queued: this.requests.has(taskId),
      started: Boolean(this.activeWorkerForTask(taskId)),
    }
  }

  async focus(taskId: string): Promise<void> {
    await this.tasks.focus(taskId)
    await this.pump()
  }

  async pump(): Promise<void> {
    if (this.pumping) {
      this.repump = true
      await this.pumping
      return
    }
    const running = this.runPump()
    this.pumping = running
    try {
      await running
    } finally {
      this.pumping = undefined
      if (this.repump) {
        this.repump = false
        await this.pump()
      }
    }
  }

  get queued(): number {
    return this.requests.size
  }

  private async runPump(): Promise<void> {
    while (this.activeCount() < this.maxWorkers) {
      const next = this.selectNext()
      if (!next) return
      this.requests.delete(next.taskId)
      try {
        await this.workers.spawn(next.taskId, next.brief)
      } catch (error) {
        this.log('dsh-dot: coordinator could not start worker', error)
      }
    }
  }

  private selectNext(): { taskId: string; brief: string } | undefined {
    const candidates: Array<{ task: DotTaskV2; brief: string }> = []
    for (const [taskId, brief] of this.requests) {
      const task = this.store.state.tasks.find((candidate) => candidate.id === taskId)
      if (!task) {
        this.requests.delete(taskId)
        continue
      }
      if (!['planned', 'blocked', 'running'].includes(task.status)) {
        this.requests.delete(taskId)
        continue
      }
      if (this.activeWorkerForTask(taskId)) {
        this.requests.delete(taskId)
        continue
      }
      candidates.push({ task, brief })
    }
    candidates.sort((left, right) => {
      const leftFocus = left.task.id === this.store.state.focusedTaskId ? 1 : 0
      const rightFocus = right.task.id === this.store.state.focusedTaskId ? 1 : 0
      if (leftFocus !== rightFocus) return rightFocus - leftFocus
      const priority = priorityRank(right.task.priority) - priorityRank(left.task.priority)
      if (priority !== 0) return priority
      return left.task.createdAt - right.task.createdAt
    })
    const first = candidates[0]
    return first ? { taskId: first.task.id, brief: first.brief } : undefined
  }

  private activeCount(): number {
    return this.store.state.workers.filter(
      (worker) => worker.status === 'starting' || worker.status === 'running',
    ).length
  }

  private activeWorkerForTask(taskId: string): boolean {
    return this.store.state.workers.some(
      (worker) => worker.taskId === taskId && (worker.status === 'starting' || worker.status === 'running'),
    )
  }

  private findTask(taskId: string): DotTaskV2 {
    const task = this.store.state.tasks.find((candidate) => candidate.id === taskId)
    if (!task) throw new Error(`task_not_found: ${taskId}`)
    return task
  }
}

function priorityRank(priority: TaskPriority): number {
  if (priority === 'high') return 3
  if (priority === 'low') return 1
  return 2
}
