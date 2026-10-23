import { StateStore } from '../state.js'
import type { DotTaskV2, TaskPriority } from '../types.js'
import {
  MAX_WORKER_LIMIT,
  MIN_WORKER_LIMIT,
  isWorkerLimit,
  sameTopic,
  type CapacityView,
  type RunningTaskView,
} from './capacity.js'
import type { TaskService } from './task-service.js'
import { WorkerLimitStore } from './worker-limit.js'

type Log = (message: string, ...args: unknown[]) => void

export interface WorkerSpawner {
  spawn(taskId: string, brief: string): Promise<unknown>
}

export interface CoordinatorOptions {
  store: StateStore
  tasks: TaskService
  workers: WorkerSpawner
  limitStore?: WorkerLimitStore
  maxWorkers: number
  log?: Log
}

export interface AssignResult {
  taskId: string
  queued: boolean
  started: boolean
  taskTitle?: string
  workerLimit?: number
  activeWorkers?: number
  queuedTasks?: number
  activeTasks?: RunningTaskView[]
  suggestScaleUp?: boolean
}

export interface SetLimitResult {
  limit: number
  previous: number
  changed: boolean
  persisted: boolean
  source: 'config' | 'user'
  startedTaskIds: string[]
}

/**
 * The only place that decides which task gets a worker slot. Focus is a
 * priority, not ownership: it never cancels another task.
 */
export class Coordinator {
  private readonly store: StateStore
  private readonly tasks: TaskService
  private readonly workers: WorkerSpawner
  private readonly limitStore: WorkerLimitStore
  private readonly log: Log
  private readonly requests = new Map<string, string>()
  private pumping?: Promise<string[]>
  private repump = false

  constructor(options: CoordinatorOptions) {
    this.store = options.store
    this.tasks = options.tasks
    this.workers = options.workers
    this.log = options.log ?? (() => {})
    this.limitStore =
      options.limitStore ?? new WorkerLimitStore(options.store.dataDir, options.maxWorkers, this.log)
  }

  get limit(): number {
    return this.limitStore.limit
  }

  get limitSource(): 'config' | 'user' {
    return this.limitStore.source
  }

  async request(taskId: string, brief: string): Promise<AssignResult> {
    await this.store.ensureLoaded()
    await this.ensureLimitLoaded()
    const task = this.findTask(taskId)
    if (!['planned', 'blocked', 'running'].includes(task.status)) {
      throw new Error(`task_not_assignable: ${task.status}`)
    }
    if (this.activeWorkerForTask(taskId)) throw new Error('task_already_has_active_worker')
    this.requests.set(taskId, brief.trim() || 'Work on the task.')
    await this.pump()
    return this.assignResult(taskId)
  }

  /**
   * Change the slot count. Raising it pumps immediately, so queued tasks start
   * without waiting for another event. Lowering it never kills a running
   * worker: the pump loop simply stops starting new ones.
   */
  async setLimit(requested: number): Promise<SetLimitResult> {
    await this.ensureLimitLoaded()
    if (!isWorkerLimit(requested)) {
      throw new Error(
        `worker_limit_out_of_range: ${requested} is outside ${MIN_WORKER_LIMIT}-${MAX_WORKER_LIMIT}`,
      )
    }
    const write = await this.limitStore.set(requested)
    const startedTaskIds = await this.pump()
    return { ...write, source: this.limitStore.source, startedTaskIds }
  }

  /** Read-only snapshot used by the capacity tools and the assign result. */
  capacityView(): CapacityView {
    const active = this.store.state.workers.filter(
      (worker) => worker.status === 'starting' || worker.status === 'running',
    )
    const runningTasks: RunningTaskView[] = []
    for (const worker of active) {
      const task = this.store.state.tasks.find((candidate) => candidate.id === worker.taskId)
      if (task) runningTasks.push({ taskId: task.id, title: task.title, status: task.status })
    }
    const queuedTaskTitles: string[] = []
    for (const taskId of this.requests.keys()) {
      const task = this.store.state.tasks.find((candidate) => candidate.id === taskId)
      if (task) queuedTaskTitles.push(task.title)
    }
    return {
      limit: this.limitStore.limit,
      minLimit: MIN_WORKER_LIMIT,
      maxLimit: MAX_WORKER_LIMIT,
      activeWorkers: active.length,
      queuedTasks: this.requests.size,
      runningTasks,
      queuedTaskTitles,
      source: this.limitStore.source,
    }
  }

  async focus(taskId: string): Promise<void> {
    await this.tasks.focus(taskId)
    await this.pump()
  }

  /**
   * Returns the ids started by this pump. A caller that arrives while another
   * pump is running requests a re-pump and gets an empty list.
   */
  async pump(): Promise<string[]> {
    if (this.pumping) {
      this.repump = true
      await this.pumping
      return []
    }
    const running = this.runPump()
    this.pumping = running
    try {
      return await running
    } finally {
      this.pumping = undefined
      if (this.repump) {
        this.repump = false
        void this.pump()
      }
    }
  }

  get queued(): number {
    return this.requests.size
  }

  private async ensureLimitLoaded(): Promise<void> {
    try {
      await this.limitStore.ensureLoaded()
    } catch (error) {
      this.log('dsh-dot: worker limit could not be loaded; keeping the fallback', error)
    }
  }

  private assignResult(taskId: string): AssignResult {
    const task = this.findTask(taskId)
    const capacity = this.capacityView()
    const queued = this.requests.has(taskId)
    const runningTaskIds = new Set(capacity.runningTasks.map((view) => view.taskId))
    const differentTopic = !this.store.state.tasks.some(
      (candidate) =>
        runningTaskIds.has(candidate.id) &&
        sameTopic(
          { title: candidate.title, request: candidate.request },
          { title: task.title, request: task.request },
        ),
    )
    return {
      taskId,
      queued,
      started: Boolean(this.activeWorkerForTask(taskId)),
      taskTitle: task.title,
      workerLimit: capacity.limit,
      activeWorkers: capacity.activeWorkers,
      queuedTasks: capacity.queuedTasks,
      activeTasks: capacity.runningTasks,
      suggestScaleUp: queued && differentTopic && capacity.limit < capacity.maxLimit,
    }
  }

  private async runPump(): Promise<string[]> {
    const started: string[] = []
    while (this.activeCount() < this.limitStore.limit) {
      const next = this.selectNext()
      if (!next) break
      this.requests.delete(next.taskId)
      try {
        await this.workers.spawn(next.taskId, next.brief)
        started.push(next.taskId)
      } catch (error) {
        this.log('dsh-dot: coordinator could not start worker', error)
      }
    }
    return started
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
