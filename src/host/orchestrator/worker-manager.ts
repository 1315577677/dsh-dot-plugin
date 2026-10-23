import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { StateStore } from '../state.js'
import { appendTaskEvent, makeTaskEvent, transitionTask } from '../tasks.js'
import type { DotTaskV2, ResolvedConfig, WorkerRecord } from '../types.js'
import { registerWorkerTools } from './worker-tools.js'
import {
  DshWorkerAgentPort,
  type WorkerAgentPort,
  type WorkerCreateOptions,
  type WorkerResumeOptions,
} from './worker-port.js'

type AnyContext = any
type Log = (message: string, ...args: unknown[]) => void

const WORKER_TOOLS = [
  'read',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
  'write',
  'edit',
  'bash',
  'dot_worker_report',
  'dot_stage_file',
]

/** Title prefix applied to every worker session Dot creates. */
const WORKER_TITLE_PREFIX = 'Dot · '
/** Character cap for a task title (the host truncates accepted titles at 80 bytes). */
const WORKER_TITLE_MAX_CHARS = 80
/** How many historical worker sessions one startup may resume to backfill titles. */
const WORKER_TITLE_BACKFILL_LIMIT = 20

/** WorkerRecord plus the session title Dot wrote; state.ts preserves extra fields. */
type WorkerRecordWithTitle = WorkerRecord & { sessionTitle?: string }

/** Readable title for a worker session: task title, request excerpt, then a short id. */
function workerTaskTitle(task: DotTaskV2): string {
  const fromTitle = task.title?.trim() ?? ''
  const fromRequest = (task.request ?? '').trim().replace(/\s+/g, ' ')
  const fallback = `任务 ${task.id.replace(/^task_/, '').slice(0, 8)}`
  const base = fromTitle || (fromRequest ? fromRequest.slice(0, 40) : '') || fallback
  return `${WORKER_TITLE_PREFIX}${base}`.slice(0, WORKER_TITLE_MAX_CHARS)
}

export interface WorkerEvent {
  kind: 'started' | 'continued' | 'idle' | 'failed' | 'cancelled'
  taskId: string
  workerId: string
  taskTitle: string
  summary: string
  result?: string
  error?: string
}

export interface WorkerManagerOptions {
  ctx: AnyContext
  config: ResolvedConfig
  store: StateStore
  workspace: string
  getSupervisor: () => any
  agentOptions?: { provider?: string; model?: string }
  port?: WorkerAgentPort
  onEvent?: (event: WorkerEvent) => void
  log?: Log
}

interface LiveWorker {
  workerId: string
  taskId: string
  agent: any
  handle: { dispose(): Promise<void> }
  startSeq: number
  started: boolean
  timer?: ReturnType<typeof setTimeout>
}

/**
 * Owns worker Agent lifecycles. It never approves actions and never mutates
 * real workspace files; all worker writes go through the staging tool.
 */
export class WorkerManager {
  private readonly ctx: AnyContext
  private readonly config: ResolvedConfig
  private readonly store: StateStore
  private readonly workspace: string
  private readonly getSupervisor: () => any
  private readonly agentOptions?: { provider?: string; model?: string }
  private readonly port: WorkerAgentPort
  private readonly onEvent: (event: WorkerEvent) => void
  private readonly log: Log
  private readonly live = new Map<string, LiveWorker>()

  constructor(options: WorkerManagerOptions) {
    this.ctx = options.ctx
    this.config = options.config
    this.store = options.store
    this.workspace = path.resolve(options.workspace)
    this.getSupervisor = options.getSupervisor
    this.agentOptions = options.agentOptions
    this.port = options.port ?? new DshWorkerAgentPort(options.ctx)
    this.onEvent = options.onEvent ?? (() => {})
    this.log = options.log ?? (() => {})
  }

  async spawn(taskId: string, brief: string): Promise<{ worker: WorkerRecord; task: DotTaskV2 }> {
    await this.store.ensureLoaded()
    const supervisor = this.getSupervisor()
    if (!supervisor) throw new Error('supervisor_not_ready')
    const task0 = this.findTask(taskId)
    if (!['planned', 'blocked', 'running'].includes(task0.status)) {
      throw new Error(`task_not_assignable: ${task0.status}`)
    }
    if (this.activeWorkerForTask(taskId)) throw new Error('task_already_has_active_worker')

    const workerId = `worker_${randomUUID()}`
    const sessionId = `session-dot-worker-${randomUUID()}`
    const targetWorkspace = path.resolve(task0.workspace ?? this.workspace)
    const stagingDir = this.stagingDir(task0.id, targetWorkspace)
    const now = Date.now()
    const worker: WorkerRecord = {
      id: workerId,
      taskId: task0.id,
      sessionId,
      status: 'starting',
      brief: brief.trim().slice(0, 4_000),
      startedAt: now,
      updatedAt: now,
      turns: 0,
    }

    await this.store.mutate((state) => {
      const task = state.tasks.find((candidate) => candidate.id === taskId)
      if (!task) throw new Error(`task_not_found: ${taskId}`)
      if (this.activeWorkerForTask(taskId)) throw new Error('task_already_has_active_worker')
      if (!['planned', 'blocked', 'running'].includes(task.status)) throw new Error(`task_not_assignable: ${task.status}`)
      state.workers.unshift(worker)
      task.workerId = worker.id
      if (task.status !== 'running') {
        transitionTask(task, 'running', 'Worker assigned', {
          now,
          detail: worker.brief,
        })
      }
      appendTaskEvent(
        task,
        makeTaskEvent('dot', 'worker_started', `Worker started: ${worker.id}`, brief, now),
      )
    })
    this.emit({ kind: 'started', taskId, workerId, taskTitle: task0.title, summary: 'Worker started' })

    let created: { agent: any; dispose(): Promise<void> }
    try {
      created = await this.port.create({
        sessionId,
        parentAgent: supervisor,
        cwd: targetWorkspace,
        parentSession: String(supervisor.id),
        agentPreset: this.config.agentPreset,
        agentOptions: this.agentOptions,
        setup: (agentCtx, agent) => this.configureWorker(agentCtx, agent, worker, task0, targetWorkspace, stagingDir, brief),
      })
    } catch (error) {
      await this.fail(workerId, error instanceof Error ? error.message : String(error))
      throw error
    }

    // A rename during `setup` is rejected: the host publishes a session only
    // after setup returns, and sessionTitle.rename requires a live session.
    // Title it here, before the first follow-up, and persist what we applied.
    const sessionTitle = workerTaskTitle(task0)
    const titled = this.titleWorkerSession(created.agent.session, sessionTitle)

    const live: LiveWorker = {
      workerId,
      taskId,
      agent: created.agent,
      handle: created,
      startSeq: 0,
      started: false,
    }
    this.live.set(workerId, live)
    live.startSeq = this.eventCount(created.agent)
    live.started = true
    try {
      await this.store.mutate((state) => {
        const record = state.workers.find((candidate) => candidate.id === workerId)
        if (record) {
          record.status = 'running'
          record.turns = 1
          record.updatedAt = Date.now()
          if (titled) (record as WorkerRecordWithTitle).sessionTitle = sessionTitle
        }
      })
      await this.port.followup(created.agent, brief)
      this.startTimer(workerId)
    } catch (error) {
      await this.fail(workerId, error instanceof Error ? error.message : String(error))
      throw error
    }

    return { worker, task: this.findTask(taskId) }
  }

  async ask(workerId: string, message: string): Promise<void> {
    await this.store.ensureLoaded()
    const live = this.live.get(workerId)
    if (!live) throw new Error('worker_not_live')
    if (this.port.status(live.agent) === 'running') throw new Error('worker_busy')
    live.startSeq = this.eventCount(live.agent)
    live.started = true
    await this.store.mutate((state) => {
      const record = state.workers.find((candidate) => candidate.id === workerId)
      if (record) {
        record.status = 'running'
        record.turns += 1
        record.updatedAt = Date.now()
      }
    })
    try {
      await this.port.followup(live.agent, message)
      this.startTimer(workerId)
    } catch (error) {
      await this.fail(workerId, error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  async continueForTask(taskId: string, message: string): Promise<{ worker: WorkerRecord; task: DotTaskV2 }> {
    await this.store.ensureLoaded()
    const worker = this.store.state.workers.find(
      (candidate) => candidate.taskId === taskId && ['idle', 'completed', 'starting'].includes(candidate.status),
    )
    if (!worker) throw new Error('worker_not_available')
    if (worker.turns >= this.config.workerMaxTurns) throw new Error('worker_max_turns_reached')
    const live = this.live.get(worker.id)
    if (!live) throw new Error('worker_not_live')
    if (this.port.status(live.agent) === 'running') throw new Error('worker_busy')

    const task = this.findTask(taskId)
    const now = Date.now()
    live.startSeq = this.eventCount(live.agent)
    live.started = true
    await this.store.mutate((state) => {
      const record = state.workers.find((candidate) => candidate.id === worker.id)
      if (record) {
        record.status = 'running'
        record.turns += 1
        record.updatedAt = now
      }
      const current = state.tasks.find((candidate) => candidate.id === taskId)
      if (!current) throw new Error(`task_not_found: ${taskId}`)
      if (current.status !== 'running') {
        transitionTask(current, 'running', 'Worker continued', { now, detail: message })
      }
      appendTaskEvent(current, makeTaskEvent('dot', 'worker_started', 'Worker continued', message, now))
    })
    this.emit({ kind: 'continued', taskId, workerId: worker.id, taskTitle: task.title, summary: 'Worker continued' })
    try {
      await this.port.followup(live.agent, message)
      this.startTimer(worker.id)
    } catch (error) {
      await this.fail(worker.id, error instanceof Error ? error.message : String(error))
      throw error
    }
    return { worker, task: this.findTask(taskId) }
  }

  async report(workerId: string, summary: string, next = ''): Promise<Record<string, unknown>> {
    await this.store.ensureLoaded()
    const text = summary.trim().slice(0, 4_000)
    if (!text) throw new Error('summary is required')
    await this.store.mutate((state) => {
      const worker = state.workers.find((candidate) => candidate.id === workerId)
      if (!worker) throw new Error(`worker_not_found: ${workerId}`)
      worker.lastResult = text
      worker.updatedAt = Date.now()
      const task = state.tasks.find((candidate) => candidate.id === worker.taskId)
      if (task) {
        if (next.trim()) task.nextAction = next.trim().slice(0, 2_000)
        appendTaskEvent(task, makeTaskEvent('worker', 'worker_progress', text, next || undefined))
      }
    })
    return { ok: true, workerId, summary: text }
  }

  async writeStaging(workerId: string, relative: string, content: string): Promise<Record<string, unknown>> {
    await this.store.ensureLoaded()
    const worker = this.store.state.workers.find((candidate) => candidate.id === workerId)
    if (!worker) throw new Error(`worker_not_found: ${workerId}`)
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > this.config.workerStageMaxBytes) throw new Error('staged_file_too_large')
    if (!relative.trim() || path.isAbsolute(relative)) throw new Error('staging_path_must_be_relative')
    const task = this.store.state.tasks.find((candidate) => candidate.id === worker.taskId)
    const staging = this.stagingDir(worker.taskId, path.resolve(task?.workspace ?? this.workspace))
    await fs.mkdir(staging, { recursive: true })
    const realStaging = await fs.realpath(staging)
    const target = path.resolve(realStaging, relative)
    if (target === realStaging || !target.startsWith(realStaging + path.sep)) {
      throw new Error('staging_path_escape')
    }
    const parent = path.dirname(target)
    await fs.mkdir(parent, { recursive: true })
    const realParent = await fs.realpath(parent)
    if (realParent !== realStaging && !realParent.startsWith(realStaging + path.sep)) {
      throw new Error('staging_symlink_escape')
    }
    try {
      const stat = await fs.lstat(target)
      if (stat.isSymbolicLink()) throw new Error('staging_symlink_escape')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await fs.writeFile(target, content, 'utf8')
    return { ok: true, path: path.relative(realStaging, target), absolutePath: target, bytes }
  }

  async reconcile(): Promise<void> {
    await this.store.ensureLoaded()
    const stale = this.store.state.workers.filter(
      (worker) =>
        (worker.status === 'starting' || worker.status === 'running') && !this.live.has(worker.id),
    )
    if (stale.length === 0) return
    await this.store.mutate((state) => {
      for (const worker of stale) {
        const record = state.workers.find((candidate) => candidate.id === worker.id)
        if (!record) continue
        record.status = 'failed'
        record.lastError = 'interrupted_by_host_restart'
        record.updatedAt = Date.now()
        const task = state.tasks.find((candidate) => candidate.id === record.taskId)
        if (task) {
          task.blockedReason = 'worker_interrupted'
          if (['running', 'coordinating', 'waiting_user'].includes(task.status)) {
            transitionTask(task, 'blocked', 'Worker interrupted by Host restart', {
              now: Date.now(),
              detail: 'No live worker Agent was found after startup.',
            })
          }
          appendTaskEvent(
            task,
            makeTaskEvent('system', 'worker_failed', 'Worker interrupted by Host restart', 'Marked blocked; retry requires a new worker.', Date.now()),
          )
        }
      }
    })
    await this.backfillWorkerTitles()
  }

  async handleIdle(workerId: string): Promise<void> {
    await this.store.ensureLoaded()
    const live = this.live.get(workerId)
    if (!live || !live.started) return
    live.started = false
    this.clearTimer(live)
    const result = this.port.result(live.agent, live.startSeq).slice(0, 8_000) || 'Worker ended without a final summary.'
    await this.store.mutate((state) => {
      const worker = state.workers.find((candidate) => candidate.id === workerId)
      if (worker) {
        worker.status = 'idle'
        worker.lastResult = result
        worker.updatedAt = Date.now()
      }
      const task = state.tasks.find((candidate) => candidate.id === live.taskId)
      if (task) {
        task.nextAction = 'Review the worker result and decide the next step.'
        if (task.status === 'running') {
          transitionTask(task, 'coordinating', 'Worker returned; supervisor review', { now: Date.now(), detail: result })
        }
        appendTaskEvent(task, makeTaskEvent('worker', 'worker_completed', 'Worker returned', result, Date.now()))
      }
    })
    this.emit({
      kind: 'idle',
      taskId: live.taskId,
      workerId,
      taskTitle: this.findTask(live.taskId).title,
      summary: 'Worker returned a result',
      result,
    })
  }

  async fail(workerId: string, error: string): Promise<void> {
    await this.store.ensureLoaded()
    const live = this.live.get(workerId)
    if (live) {
      this.clearTimer(live)
      live.started = false
      await this.port.dispose(live.agent).catch(() => {})
      this.live.delete(workerId)
    }
    const reason = error.slice(0, 2_000)
    let taskTitle = ''
    await this.store.mutate((state) => {
      const worker = state.workers.find((candidate) => candidate.id === workerId)
      if (worker) {
        worker.status = 'failed'
        worker.lastError = reason
        worker.updatedAt = Date.now()
      }
      const task = state.tasks.find((candidate) => candidate.id === worker?.taskId)
      if (task) {
        taskTitle = task.title
        task.blockedReason = `worker_failed: ${reason}`
        if (['running', 'coordinating', 'waiting_user'].includes(task.status)) {
          transitionTask(task, 'blocked', 'Worker failed', { now: Date.now(), detail: reason })
        }
        appendTaskEvent(task, makeTaskEvent('system', 'worker_failed', 'Worker failed', reason, Date.now()))
      }
    })
    if (taskTitle) {
      this.emit({
        kind: 'failed',
        taskId: this.store.state.workers.find((worker) => worker.id === workerId)?.taskId ?? '',
        workerId,
        taskTitle,
        summary: 'Worker failed',
        error: reason,
      })
    }
  }

  async cancel(workerId: string, reason = 'cancelled'): Promise<void> {
    await this.store.ensureLoaded()
    const live = this.live.get(workerId)
    if (live) {
      this.clearTimer(live)
      live.started = false
      await this.port.dispose(live.agent).catch(() => {})
      this.live.delete(workerId)
    }
    await this.store.mutate((state) => {
      const worker = state.workers.find((candidate) => candidate.id === workerId)
      if (worker) {
        worker.status = 'cancelled'
        worker.updatedAt = Date.now()
      }
      const task = state.tasks.find((candidate) => candidate.id === worker?.taskId)
      if (task) {
        task.blockedReason = reason
        if (!['done', 'cancelled'].includes(task.status)) {
          transitionTask(task, 'cancelled', 'Task cancelled', { now: Date.now(), detail: reason })
        }
        appendTaskEvent(task, makeTaskEvent('user', 'cancelled', 'Worker cancelled', reason, Date.now()))
      }
    })
  }

  async disposeAll(): Promise<void> {
    for (const live of this.live.values()) {
      this.clearTimer(live)
      await this.port.dispose(live.agent).catch(() => {})
    }
    this.live.clear()
  }

  private async configureWorker(
    agentCtx: AnyContext,
    agent: any,
    worker: WorkerRecord,
    task: DotTaskV2,
    targetWorkspace: string,
    stagingDir: string,
    brief: string,
  ): Promise<void> {
    const readRoots = this.readRoots(targetWorkspace)
    agentCtx.systemPrompt.section({
      name: 'dsh-dot:worker',
      order: 26,
      text: workerPrompt(task, brief, targetWorkspace, stagingDir, readRoots),
    })
    const presets = this.ctx.get?.('agentPresets')
    if (presets?.mount) {
      await presets.mount(agentCtx, this.config.agentPreset)
    }
    registerWorkerTools(agentCtx, this, worker, task, stagingDir)
    // Titles are applied after creation: `setup` runs before the host publishes
    // the session, and sessionTitle.rename only accepts live sessions.
    try {
      agentCtx.tools.restrict({ allow: WORKER_TOOLS })
    } catch (error) {
      this.log('dsh-dot: worker global restriction skipped', error)
    }
    agentCtx.tools.guard((exec: any) => {
      const name = String(exec.name ?? '')
      if (name === 'dot_worker_report' || name === 'dot_stage_file') return undefined
      if (name === 'web_search' || name === 'web_fetch') return undefined
      if (name === 'read' || name === 'glob' || name === 'grep') {
        const target = exec.args?.file_path ?? exec.args?.path ?? exec.args?.cwd
        if (typeof target === 'string' && !this.pathAllowed(target, readRoots, targetWorkspace)) {
          return `DSH Dot worker may only read within its task roots: ${target}`
        }
        return undefined
      }
      if (name === 'write' || name === 'edit') {
        const target = exec.args?.file_path ?? exec.args?.path
        if (typeof target === 'string' && !this.pathAllowed(target, [targetWorkspace], targetWorkspace)) {
          return `DSH Dot worker may only write inside its assigned workspace: ${targetWorkspace}`
        }
        return undefined
      }
      if (name === 'bash') return undefined
      return `DSH Dot worker tool "${name}" is not allowed.`
    })
    agentCtx.on('agent/status', (payload: any) => {
      if (payload?.status !== 'idle') return
      void this.handleIdle(worker.id)
    })
  }

  private titleWorkerSession(session: any, title: string): boolean {
    const titles = this.ctx.get?.('sessionTitle')
    if (!titles?.rename) return false
    try {
      titles.rename(session, title)
      return true
    } catch (error) {
      this.log('dsh-dot: could not title the worker session', error)
      return false
    }
  }

  private workerSessionTitle(session: any): string {
    try {
      return String(this.ctx.get?.('sessionTitle')?.get?.(session)?.title ?? '').trim()
    } catch {
      return ''
    }
  }

  /**
   * Title historical worker sessions whose list row still shows no name.
   * The host title service only renames live sessions, so each candidate is
   * resumed, renamed, and disposed again. Recorded titles and titles already
   * present on the session stop it, so repeated startups do not re-resume.
   */
  private async backfillWorkerTitles(): Promise<void> {
    if (!this.ctx.get?.('sessionTitle')?.rename) return
    const applied: Array<{ id: string; title: string }> = []
    let budget = WORKER_TITLE_BACKFILL_LIMIT
    for (const worker of this.store.state.workers) {
      if (budget <= 0) break
      if ((worker as WorkerRecordWithTitle).sessionTitle) continue
      if (this.live.has(worker.id)) continue
      const task = this.store.state.tasks.find((candidate) => candidate.id === worker.taskId)
      if (!task) continue
      budget -= 1
      let handle: { agent: any; dispose(): Promise<void> } | undefined
      try {
        handle = await this.port.resume({
          sessionId: worker.sessionId,
          parentAgent: this.getSupervisor() ?? undefined,
          agentOptions: this.agentOptions,
          setup: () => {},
        })
        const current = this.workerSessionTitle(handle.agent.session)
        if (current) {
          applied.push({ id: worker.id, title: current })
          continue
        }
        const title = workerTaskTitle(task)
        if (this.titleWorkerSession(handle.agent.session, title)) {
          applied.push({ id: worker.id, title })
        }
      } catch (error) {
        this.log(`dsh-dot: could not backfill the session title for ${worker.id}`, error)
      } finally {
        if (handle) await handle.dispose().catch(() => {})
      }
    }
    if (applied.length === 0) return
    await this.store.mutate((state) => {
      for (const { id, title } of applied) {
        const record = state.workers.find((candidate) => candidate.id === id)
        if (record) (record as WorkerRecordWithTitle).sessionTitle = title
      }
    })
  }

  private readRoots(targetWorkspace = this.workspace): string[] {
    const roots = new Set<string>([path.resolve(targetWorkspace)])
    for (const source of this.config.sources) {
      if (source.kind === 'directory' && source.path) roots.add(path.resolve(source.path))
    }
    return [...roots]
  }

  private pathAllowed(target: string, roots: string[], base = this.workspace): boolean {
    const resolved = path.resolve(base, target)
    return roots.some((root) => {
      const absolute = path.resolve(root)
      return resolved === absolute || resolved.startsWith(absolute + path.sep)
    })
  }

  private stagingDir(taskId: string, targetWorkspace = this.workspace): string {
    return path.join(path.resolve(targetWorkspace), '.dsh-dot', 'staging', taskId)
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

  private eventCount(agent: any): number {
    try {
      return agent?.session?.snapshotEvents?.().length ?? 0
    } catch {
      return 0
    }
  }

  private startTimer(workerId: string): void {
    this.clearTimer(this.live.get(workerId))
    const live = this.live.get(workerId)
    if (!live) return
    live.timer = setTimeout(() => {
      void this.fail(workerId, `worker_timeout: no turn completion within ${this.config.workerTimeoutMs}ms`)
    }, this.config.workerTimeoutMs)
    ;(live.timer as any).unref?.()
  }

  private clearTimer(live: LiveWorker | undefined): void {
    if (live?.timer) clearTimeout(live.timer)
    if (live) live.timer = undefined
  }

  private emit(event: WorkerEvent): void {
    try {
      this.onEvent(event)
    } catch (error) {
      this.log('dsh-dot: worker event handler failed', error)
    }
  }
}

function workerPrompt(task: DotTaskV2, brief: string, targetWorkspace: string, stagingDir: string, readRoots: string[]): string {
  return `You are a DSH Dot worker.

Task: ${task.title}
User request: ${task.request}
Current next action: ${task.nextAction}
Brief for this turn: ${brief}

Assigned workspace (the only writable workspace):
${targetWorkspace}

Read roots:
${readRoots.map((root) => `- ${root}`).join('\n')}

Optional staging directory for drafts:
${stagingDir}

Rules:
- You may read, write, edit, and run shell commands inside the assigned workspace.
- Do not access or modify any other workspace.
- Do not send, publish, delete, invite, or perform external side effects without user approval.
- Use dot_worker_report for short progress updates.
- End with a concise result: what you did, evidence, outputs, and what remains.
- Do not claim completion; the supervisor decides the task state.`
}
