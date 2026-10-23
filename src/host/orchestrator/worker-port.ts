import { randomUUID } from 'node:crypto'

type AnyContext = any

export interface WorkerAgentHandle {
  agent: any
  dispose(): Promise<void>
}

/**
 * Authoritative view of a worker Session, read from the live Agent registry.
 * `missing` means the host has no live Agent for that id (so no turn can run);
 * `unknown` means the host could not answer and callers must stay conservative.
 */
export type WorkerSessionStatus = 'running' | 'idle' | 'missing' | 'unknown'

export interface WorkerCreateOptions {
  sessionId: string
  parentAgent: any
  cwd: string
  parentSession: string
  agentPreset: string
  agentOptions?: { provider?: string; model?: string }
  setup: (agentCtx: AnyContext, agent: any) => void | Promise<void>
}

export interface WorkerResumeOptions {
  sessionId: string
  parentAgent: any
  agentOptions?: { provider?: string; model?: string }
  setup: (agentCtx: AnyContext, agent: any) => void | Promise<void>
}

/**
 * The small seam between WorkerManager and DSH's Agent service. Tests can
 * drive worker lifecycle without a live model or a real Agent runtime.
 */
export interface WorkerAgentPort {
  create(options: WorkerCreateOptions): Promise<WorkerAgentHandle>
  resume(options: WorkerResumeOptions): Promise<WorkerAgentHandle>
  followup(agent: any, message: string): Promise<void>
  status(agent: any): string
  /** Look up the live Agent registry by Session id. */
  sessionStatus(sessionId: string): WorkerSessionStatus
  result(agent: any, startIndex: number): string
  dispose(agent: any): Promise<void>
}

export class DshWorkerAgentPort implements WorkerAgentPort {
  constructor(private readonly ctx: AnyContext) {}

  async create(options: WorkerCreateOptions): Promise<WorkerAgentHandle> {
    const handle = await this.ctx.agents.create({
      sessionId: options.sessionId,
      parentAgent: options.parentAgent,
      meta: {
        cwd: options.cwd,
        agentPreset: options.agentPreset,
      },
      agentOptions: options.agentOptions,
      setup: options.setup,
    })
    return { agent: handle.agent, dispose: () => handle.dispose() }
  }

  async resume(options: WorkerResumeOptions): Promise<WorkerAgentHandle> {
    const handle = await this.ctx.agents.resume({
      resumeSessionId: options.sessionId,
      parentAgent: options.parentAgent,
      agentOptions: options.agentOptions,
      setup: options.setup,
    })
    return { agent: handle.agent, dispose: () => handle.dispose() }
  }

  async followup(agent: any, message: string): Promise<void> {
    const notice = {
      id: `dot-worker-notice-${randomUUID()}`,
      role: 'user',
      content: [{ type: 'text', text: message }],
      source: { kind: 'dsh-dot', form: 'notice', summary: 'Dot worker brief' },
    }
    await Promise.resolve(agent.followup(notice))
  }

  status(agent: any): string {
    return String(agent?.status ?? 'idle')
  }

  /**
   * `ctx.agents.get()` is the host's live-Agent registry: an id is present
   * exactly while an Agent handle for that Session exists. A missing id is
   * therefore a positive "nothing can be running" answer, while a failure to
   * ask is `unknown` and must never authorize a replacement worker.
   */
  sessionStatus(sessionId: string): WorkerSessionStatus {
    try {
      const registry = this.ctx?.agents
      const get = registry?.get
      if (typeof get !== 'function') return 'unknown'
      const agent = get.call(registry, sessionId)
      if (!agent) return 'missing'
      const status = String(agent.status ?? '')
      if (status === 'running') return 'running'
      if (status === 'idle') return 'idle'
      return 'unknown'
    } catch {
      return 'unknown'
    }
  }

  result(agent: any, startIndex: number): string {
    try {
      const events = agent?.session?.snapshotEvents?.() ?? []
      for (let index = events.length - 1; index >= startIndex; index -= 1) {
        const event = events[index]
        if (event?.type !== 'assistant/message') continue
        const blocks = event.data?.message?.content ?? []
        const text = blocks
          .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
          .map((block: any) => block.text)
          .join('\n')
          .trim()
        if (text) return text
      }
    } catch {
      // A disposed session may no longer be readable.
    }
    return ''
  }

  async dispose(agent: any): Promise<void> {
    await Promise.resolve(agent?.dispose?.())
  }
}
