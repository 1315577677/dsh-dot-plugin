import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { Reviewer } from './reviewer.js'
import { StateStore } from './state.js'
import { registerDotTools } from './tools.js'
import { appendTaskEvent, makeTask, makeTaskEvent, transitionTask } from './tasks.js'
import { autologTasks } from './memory/autolog.js'
import { buildStartupDigest, buildWakeSnapshot } from './memory/digest.js'
import { createMemory, type MemoryHandle } from './memory/tools.js'
import { SUPERVISOR_PERSONA } from './orchestrator/supervisor.js'
import { TaskService } from './orchestrator/task-service.js'
import { WorkerManager, type WorkerEvent } from './orchestrator/worker-manager.js'
import { Coordinator, type AssignResult } from './orchestrator/coordinator.js'
import {
  MAX_WORKER_LIMIT,
  MIN_WORKER_LIMIT,
  isWorkerLimit,
  type CapacityView,
} from './orchestrator/capacity.js'
import { WorkerLimitStore } from './orchestrator/worker-limit.js'
import type {
  ClientState,
  DotTaskV2,
  DotChatMessage,
  DotTrigger,
  Proposal,
  ProposalInput,
  ResearchResult,
  ResolvedConfig,
  RiskLevel,
  RuleDecision,
  ScheduleView,
} from './types.js'

type AnyContext = any
type Log = (message: string, ...args: unknown[]) => void

const SUPPORT_TOOLS = ['read', 'glob', 'grep']
const CHAT_QUOTE_PREVIEW_MAX = 60
const PERSONA = [
  'You are Dot, a persistent proactive agent working inside DeepSeek Harness.',
  'Your job is to inspect the user’s configured read-only sources, find concrete work that would help, and propose it.',
  'During research you have only read-only tools. Never claim to have changed, sent, deleted, or published anything.',
  'When you find an action worth taking, call dot_propose_action. State the evidence, the exact outcome, the execution tools, and the target path or recipient.',
  'You cannot approve your own proposals. The user approves or rejects them in the DSH Dot panel.',
  'When the user approves a proposal, you will be woken in execution mode with exactly the approved tools. Execute only that action, then report the real result.',
  'If nothing is worth doing, say so briefly. Prefer silence over invented work.',
  'Do not invent sources. Only inspect the sources listed in the research prompt.',
].join('\n')

/**
 * Owns the persistent Dot Agent and the research/execution phases.
 *
 * Safety model:
 *  - research phase: a global-tool allowlist plus a scoped monotonic guard;
 *  - proposal phase: independent small-model risk review and user rules;
 *  - execution phase: only after approval, with a per-proposal tool allowlist
 *    and the same guard. The main user Session is never intercepted.
 */
export class DotRuntime {
  readonly ready: Promise<void>
  private agent?: any
  private handle?: { agent: any; dispose(): Promise<void> }
  private dotCtx?: AnyContext
  private disposed = false
  private initialized = false
  private lastError?: string
  private lastDeliveryError?: string
  private chatRecoverySeq = 0
  private researchRestriction?: () => void
  private executionRestriction?: () => void
  private researchTools = new Set<string>()
  private executionTools = new Set<string>()
  readonly tasks: TaskService
  readonly workers: WorkerManager
  readonly coordinator: Coordinator
  readonly limits: WorkerLimitStore
  readonly memory: MemoryHandle
  /** The Dot chat message that woke the current turn, when the turn came from chat. */
  private wakeMessageId?: string
  private memoryDigest = ''
  private workerEvents: WorkerEvent[] = []
  private workerEventBusy = false
  private taskNotices: string[] = []
  private taskNoticeBusy = false
  private executingId?: string
  private executionStartSeq = 0
  private executor?: {
    handle: { dispose(): Promise<void> }
    agent: any
    proposal: Proposal
    startSeq: number
    timer?: ReturnType<typeof setTimeout>
  }
  private proposalsThisRound = 0
  private readonly startedAt = Date.now()

  constructor(
    private readonly ctx: AnyContext,
    private readonly config: ResolvedConfig,
    private readonly store: StateStore,
    private readonly reviewer: Reviewer,
    private readonly log: Log = () => {},
  ) {
    this.tasks = new TaskService(store, log)
    this.limits = new WorkerLimitStore(store.dataDir, this.config.maxWorkers, log)
    this.memory = createMemory(
      path.join(store.dataDir, 'memory'),
      log,
      (source) => this.validateMemorySource(source),
    )
    this.workers = new WorkerManager({
      ctx,
      config: this.config,
      store,
      workspace: this.cwd(),
      getSupervisor: () => this.agent,
      agentOptions: this.agentOptions(),
      onEvent: (event) => this.handleWorkerEvent(event),
      log,
    })
    this.coordinator = new Coordinator({
      store,
      tasks: this.tasks,
      workers: this.workers,
      maxWorkers: this.limits.limit,
      limitStore: this.limits,
      log,
    })
    this.ready = this.initialize().catch((error) => {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.log('dsh-dot: Dot Agent initialization failed', error)
    })
  }

  /** Register the Agent lifecycle and the research heartbeat. */
  start(): void {
    this.ctx.effect(
      () => {
        return async () => {
          this.disposed = true
          await this.ready.catch(() => {})
          if (this.executor) {
            if (this.executor.timer) clearTimeout(this.executor.timer)
            await this.executor.handle.dispose().catch(() => {})
            this.executor = undefined
          }
          await this.workers.disposeAll()
          await this.handle?.dispose().catch((error: unknown) => {
            this.log('dsh-dot: Dot Agent disposal failed', error)
          })
        }
      },
      'dsh-dot: Dot Agent lifecycle',
    )

    this.ctx.effect(
      () => {
        if (this.config.orchestrator) return () => {}
        let stopped = false
        let timer: ReturnType<typeof setTimeout> | undefined

        const schedule = (delay: number) => {
          if (stopped) return
          timer = setTimeout(tick, Math.max(1_000, delay))
          ;(timer as any).unref?.()
        }

        const tick = async () => {
          if (stopped) return
          try {
            await this.ready
            await this.runResearch('timer')
          } catch (error) {
            this.lastError = error instanceof Error ? error.message : String(error)
            this.log('dsh-dot: research heartbeat failed', error)
          } finally {
            if (!stopped) schedule(this.config.researchIntervalMs)
          }
        }

        void this.ready.then(() => {
          if (!stopped) schedule(this.config.initialDelayMs)
        })
        return () => {
          stopped = true
          if (timer) clearTimeout(timer)
        }
      },
      'dsh-dot: research heartbeat',
    )
  }

  get sessionId(): string | undefined {
    return this.agent?.id ? String(this.agent.id) : undefined
  }

  private async initialize(): Promise<void> {
    await this.store.ensureLoaded()
    await this.limits.ensureLoaded()
    if (!this.config.enabled) {
      this.initialized = true
      return
    }

    await this.refreshMemory()
    await this.workers.reconcile()
    const existing = this.store.state.dotSessionId
    if (existing) {
      try {
        await this.resume(existing)
        await this.reconcileInterruptedExecution()
        this.initialized = true
        if (this.store.state.pendingAuto.length > 0) setTimeout(() => this.kickExecution(), 250).unref?.()
        return
      } catch (error) {
        this.log(`dsh-dot: could not resume Dot Session "${existing}"; creating a new one`, error)
      }
    }

    await this.create()
    await this.reconcileInterruptedExecution()
    this.initialized = true
    if (this.store.state.pendingAuto.length > 0) setTimeout(() => this.kickExecution(), 250).unref?.()
  }

  private async resume(sessionId: string): Promise<void> {
    const handle = await this.ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: this.agentOptions(),
      setup: (agentCtx: AnyContext, agent: any) => this.configureAgent(agentCtx, agent),
    })
    await this.attach(handle)
  }

  private async create(): Promise<void> {
    const sessionId = `session-dot-${randomUUID()}`
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: this.cwd(), origin: 'subagent' },
      agentOptions: this.agentOptions(),
      setup: (agentCtx: AnyContext, agent: any) => this.configureAgent(agentCtx, agent),
    })
    await this.attach(handle)
  }

  private async attach(handle: { agent: any; dispose(): Promise<void> }): Promise<void> {
    if (this.disposed) {
      await handle.dispose().catch(() => {})
      return
    }
    this.handle = handle
    this.agent = handle.agent
    this.setTitle()
    await this.store.mutate((state) => {
      state.dotSessionId = String(handle.agent.id)
      delete state.lastError
    })
  }

  private async configureAgent(agentCtx: AnyContext, agent: any): Promise<void> {
    this.dotCtx = agentCtx

    // Bind the requested Agent preset before our own scoped tools. The preset
    // supplies the real read-only tool set (read/glob/grep/web) and the
    // standard approval/sandbox behavior.
    const presets = this.ctx.get?.('agentPresets')
    if (presets?.mount) {
      try {
        await presets.mount(agentCtx, this.config.agentPreset || undefined)
      } catch (error) {
        this.lastError = `Agent preset "${this.config.agentPreset}" failed to mount: ${
          error instanceof Error ? error.message : String(error)
        }`
        this.log('dsh-dot: Agent preset mount failed', error)
      }
    } else {
      this.lastError = 'agentPresets service unavailable; Dot research tools are not composed'
    }

    agentCtx.systemPrompt.section({
      name: 'dsh-dot:persona',
      order: 25,
      text: this.config.orchestrator ? SUPERVISOR_PERSONA : PERSONA,
    })

    if (this.memoryDigest) {
      agentCtx.systemPrompt.section({
        name: 'dsh-dot:memory',
        order: 26,
        text: this.memoryDigest,
      })
    }

    registerDotTools(agentCtx, this, agent, this.config.orchestrator)

    // Monotonic guard: a phase change can only narrow or replace the set of
    // callable global tools. It is scoped to this Agent, not the user Session.
    agentCtx.tools.guard((exec: any) => {
      const name = String(exec.name ?? '')
      if (name.startsWith('dot_')) return undefined
      if (this.config.orchestrator) {
        return `DSH Dot supervisor delegates work to workers. Tool "${name}" is not available in the supervisor.`
      }
      const allowed = this.executingId
        ? this.executionTools
        : this.researchTools
      if (allowed.has(name)) return undefined
      return this.executingId
        ? `DSH Dot execution is limited to the approved tools: ${[...allowed].join(', ') || '(none)'}`
        : `DSH Dot research is read-only. Tool "${name}" is not allowed.`
    })

    this.applyResearchRestriction(agentCtx, agent)

    agentCtx.on('agent/status', (payload: any) => {
      if (payload?.status !== 'idle') return
      if (payload.agent?.id !== agent.id) return
      void this.onIdle(agent)
    })
  }

  private applyResearchRestriction(agentCtx: AnyContext, agent: any): void {
    this.researchRestriction?.()
    this.researchRestriction = undefined
    this.researchTools = this.config.orchestrator
      ? new Set()
      : availableTools(this.ctx, this.config.readOnlyTools, agent)
    if (this.config.orchestrator) {
      try {
        this.researchRestriction = agentCtx.tools.restrict({ allow: [] })
      } catch (error) {
        this.log('dsh-dot: supervisor tool restriction skipped', error)
      }
      return
    }
    if (this.researchTools.size > 0) {
      try {
        this.researchRestriction = agentCtx.tools.restrict({ allow: [...this.researchTools] })
      } catch (error) {
        // Preset-scoped tools may not be visible to the global restriction
        // filter. The monotonic guard below remains authoritative.
        this.log('dsh-dot: global tool restriction skipped', error)
      }
    }
  }

  private applyExecutionRestriction(agentCtx: AnyContext, agent: any, proposal: Proposal): void {
    this.researchRestriction?.()
    this.researchRestriction = undefined
    this.executionRestriction?.()
    this.executionRestriction = undefined

    this.executionTools = availableTools(this.ctx, [
      ...SUPPORT_TOOLS,
      ...proposal.executionTools,
    ], agent)
    if (this.executionTools.size > 0) {
      try {
        this.executionRestriction = agentCtx.tools.restrict({ allow: [...this.executionTools] })
      } catch (error) {
        this.log('dsh-dot: execution tool restriction skipped', error)
      }
    }
  }

  private restoreResearchRestriction(): void {
    this.executionRestriction?.()
    this.executionRestriction = undefined
    if (this.dotCtx && this.agent) this.applyResearchRestriction(this.dotCtx, this.agent)
  }

  /** Mark an execution that was cut off by a Host restart instead of attributing a stale report. */
  private async reconcileInterruptedExecution(): Promise<void> {
    await this.store.ensureLoaded()
    const id = this.store.state.executingId
    if (!id) return
    await this.store.mutate((state) => {
      const proposal = state.proposals.find((candidate) => candidate.id === id)
      if (proposal) {
        proposal.status = 'failed'
        proposal.updatedAt = Date.now()
        proposal.result =
          'The execution turn was interrupted by a Host restart. Verify the target path before retrying.'
      }
      state.executingId = undefined
    })
  }

  /** Wake the Dot for one read-only research round. */
  async runResearch(reason: string): Promise<ResearchResult> {
    if (this.config.orchestrator) {
      return { started: false, reason: 'orchestrator_not_ready' }
    }
    await this.ready
    if (!this.config.enabled) return { started: false, reason: 'disabled' }
    if (!this.agent) return { started: false, reason: this.lastError ?? 'agent_not_ready' }
    if (this.agent.status !== 'idle') return { started: false, reason: 'agent_busy' }
    if (this.config.sources.filter((source) => source.enabled !== false).length === 0) {
      return { started: false, reason: 'no_sources' }
    }

    this.proposalsThisRound = 0
    const prompt = this.buildResearchPrompt()
    await this.store.mutate((state) => {
      state.lastResearchAt = Date.now()
      delete state.lastError
    })

    try {
      this.agent.followup(noticeMessage(prompt, 'Dot research round'))
      return { started: true, reason }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.store.mutate((state) => {
        state.lastError = message
      })
      return { started: false, reason: message }
    }
  }

  /** Create a proposal from the Dot's scoped tool. Never executes it. */
  async proposeAction(args: any, signal?: AbortSignal): Promise<Record<string, unknown>> {
    await this.store.ensureLoaded()
    if (this.disposed) throw new Error('DSH Dot is disposed')
    if (!this.agent) throw new Error('Dot Agent is not ready')
    if (this.proposalsThisRound >= this.config.maxProposalsPerRound) {
      throw new Error(
        `This research round already has ${this.config.maxProposalsPerRound} proposals; wait for the next round.`,
      )
    }

    const input = validateProposalInput(args)
    if (input.taskId) {
      const task = this.store.state.tasks.find((candidate) => candidate.id === input.taskId)
      if (!task) throw new Error(`task_not_found: ${input.taskId}`)
      if (task.status === 'done' || task.status === 'cancelled') {
        throw new Error(`task_not_actionable: ${task.status}`)
      }
      input.workerId = task.workerId
    }
    const executionTools = normalizeExecutionTools(
      input.executionTools,
      this.config.executionTools,
    )
    input.executionTools = executionTools

    const fingerprint = proposalFingerprint(input)
    const duplicate = this.store.state.proposals.find(
      (candidate) =>
        proposalFingerprint(candidate) === fingerprint &&
        candidate.status !== 'rejected' &&
        candidate.status !== 'failed',
    )
    if (duplicate) {
      return {
        proposalId: duplicate.id,
        status: duplicate.status,
        decision: duplicate.decision,
        risk: duplicate.risk,
        riskReason: duplicate.riskReason,
        executionTools: duplicate.executionTools,
        duplicate: true,
        note: 'An equivalent proposal already exists; not creating a duplicate.',
      }
    }

    const review = await this.reviewer.reviewProposal(input, signal)
    const rule = this.reviewer.applyRule(input)
    let decision: RuleDecision = rule?.decision ?? 'ask'

    if (decision === 'allow') {
      // Auto-execution is opt-in and limited to genuinely low-risk proposals.
      if (!this.config.autoApproveLowRisk || review.risk !== 'low') decision = 'ask'
    }
    if (decision === 'ask' && rule?.decision === 'allow' && review.risk === 'high') {
      decision = 'ask'
    }

    const now = Date.now()
    const proposal: Proposal = {
      id: `proposal_${randomUUID()}`,
      ...input,
      risk: review.risk,
      riskReason: review.reason,
      decision,
      status:
        decision === 'deny'
          ? 'rejected'
          : decision === 'allow'
            ? 'approved'
            : 'pending',
      createdAt: now,
      updatedAt: now,
      ...(decision === 'deny' ? { decidedAt: now } : {}),
    }

    await this.store.mutate((state) => {
      state.proposals.unshift(proposal)
      if (decision === 'allow') state.pendingAuto.push(proposal.id)
    })
    if (proposal.taskId) {
      await this.tasks.recordProposalCreated(proposal.taskId, proposal.id, proposal.title)
    }
    this.proposalsThisRound += 1

    return {
      proposalId: proposal.id,
      taskId: proposal.taskId,
      status: proposal.status,
      decision,
      risk: proposal.risk,
      riskReason: proposal.riskReason,
      executionTools: proposal.executionTools,
      note:
        decision === 'allow'
          ? 'Policy allowed this low-risk proposal; it will run after the research turn.'
          : decision === 'deny'
            ? 'A user rule denied this proposal.'
            : 'Waiting for the user in the DSH Dot panel.',
    }
  }

  async approveProposal(id: string): Promise<{ ok: boolean; error?: string; proposal?: Proposal }> {
    await this.ready
    const proposal = this.store.state.proposals.find((candidate) => candidate.id === id)
    if (!proposal) return { ok: false, error: 'proposal_not_found' }
    if (proposal.status !== 'pending') return { ok: false, error: `proposal_is_${proposal.status}` }
    if (proposal.executionTools.length === 0) {
      await this.store.mutate(() => {
        proposal.status = 'executed'
        proposal.decision = 'allow'
        proposal.decidedAt = Date.now()
        proposal.executedAt = Date.now()
        proposal.updatedAt = Date.now()
        proposal.result = 'Approved; no execution tools were requested.'
      })
      await this.recordProposalTaskEvent(proposal, 'executed', 'Approved; no execution tools were requested.')
      this.queueTaskNotice(`Proposal executed: ${proposal.title}\nApproved without tools. Update the task and tell the user what this means.`)
      return { ok: true, proposal }
    }

    await this.store.mutate((state) => {
      proposal.decision = 'allow'
      proposal.status = 'approved'
      proposal.decidedAt = Date.now()
      proposal.updatedAt = Date.now()
      if (!state.pendingAuto.includes(proposal.id)) state.pendingAuto.push(proposal.id)
    })
    await this.recordProposalTaskEvent(proposal, 'approved', 'User approved the proposal.')
    void this.kickExecution()
    return { ok: true, proposal }
  }

  async rejectProposal(id: string, note?: string): Promise<{ ok: boolean; error?: string; proposal?: Proposal }> {
    await this.ready
    const proposal = this.store.state.proposals.find((candidate) => candidate.id === id)
    if (!proposal) return { ok: false, error: 'proposal_not_found' }
    if (proposal.status !== 'pending') return { ok: false, error: `proposal_is_${proposal.status}` }
    await this.store.mutate((state) => {
      proposal.status = 'rejected'
      proposal.decision = 'deny'
      proposal.decidedAt = Date.now()
      proposal.updatedAt = Date.now()
      if (note) proposal.result = `Rejected: ${note}`
      state.pendingAuto = state.pendingAuto.filter((candidate) => candidate !== proposal.id)
    })
    await this.recordProposalTaskEvent(proposal, 'rejected', note ? `Rejected: ${note}` : 'User rejected the proposal.')
    this.injectNotice(
      `Action rejected by the user: ${proposal.title}${note ? `\nNote: ${note}` : ''}`,
      'Dot action rejected',
    )
    this.queueTaskNotice(`Proposal rejected: ${proposal.title}${note ? `\nReason: ${note}` : ''}\nUpdate the task and ask what the user wants next.`)
    return { ok: true, proposal }
  }

  private kickExecution(): void {
    if (!this.agent || !this.dotCtx) return
    if (this.executingId) return
    if (!this.config.orchestrator && this.agent.status !== 'idle') return
    const next = this.store.state.pendingAuto[0]
    if (!next) return
    const proposal = this.store.state.proposals.find(
      (candidate) => candidate.id === next && candidate.status === 'approved',
    )
    if (!proposal) {
      void this.store.mutate((state) => {
        state.pendingAuto = state.pendingAuto.filter((id) => id !== next)
      })
      return
    }
    if (this.config.orchestrator) void this.executeProposalInWorker(proposal)
    else void this.executeProposal(proposal)
  }

  private async executeProposalInWorker(proposal: Proposal): Promise<void> {
    await this.ready
    if (!this.agent) return
    if (this.executor || this.executingId) return
    this.executingId = proposal.id
    await this.store.mutate((state) => {
      proposal.status = 'executing'
      proposal.updatedAt = Date.now()
      state.executingId = proposal.id
      state.pendingAuto = state.pendingAuto.filter((id) => id !== proposal.id)
    })
    let created: { agent: any; dispose(): Promise<void> }
    try {
      created = await this.ctx.agents.create({
        sessionId: `session-dot-executor-${randomUUID()}`,
        parentAgent: this.agent,
        meta: {
          cwd: this.cwd(),
          parentSession: String(this.agent.id),
          origin: 'subagent',
          agentPreset: this.config.agentPreset,
        },
        agentOptions: this.agentOptions(),
        setup: (agentCtx: AnyContext, agent: any) => this.configureApprovedExecutor(agentCtx, agent, proposal),
      })
    } catch (error) {
      await this.finishApprovedExecution(undefined, error instanceof Error ? error.message : String(error), true)
      return
    }

    const startSeq = this.executionEventCount(created.agent)
    const node = {
      handle: created,
      agent: created.agent,
      proposal,
      startSeq,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
    }
    this.executor = node
    node.timer = setTimeout(() => {
      void this.finishApprovedExecution(node, 'Approved execution timed out.', true)
    }, this.config.workerTimeoutMs)
    ;(node.timer as any).unref?.()

    const instruction = [
      '[DSH Dot — approved execution worker]',
      `Approved action: ${proposal.proposedAction}`,
      `Task: ${proposal.taskId ?? '(none)'}`,
      `Original finding: ${proposal.description}`,
      `Evidence: ${proposal.evidence || '(none provided)'}`,
      `Approved execution tools: ${proposal.executionTools.join(', ') || '(none)'}`,
      `Instruction: ${proposal.executionInstruction || proposal.proposedAction}`,
      'You are the executor, not the Dot supervisor. Execute only this approved action.',
      'Do not create tasks, do not propose actions, do not ask for approval, and do not invent new external actions.',
      'Do not send, publish, pay, delete, or change an account unless that exact action was approved.',
      'When finished, report the concrete result, including files changed or the exact reason it could not be completed.',
    ].join('\n')
    try {
      await Promise.resolve(created.agent.followup(noticeMessage(instruction, 'Dot approved execution')))
    } catch (error) {
      await this.finishApprovedExecution(
        node,
        error instanceof Error ? error.message : String(error),
        true,
      )
    }
  }

  private async configureApprovedExecutor(
    agentCtx: AnyContext,
    agent: any,
    proposal: Proposal,
  ): Promise<void> {
    const presets = this.ctx.get?.('agentPresets')
    if (presets?.mount) await presets.mount(agentCtx, this.config.agentPreset || undefined)
    agentCtx.systemPrompt.section({
      name: 'dsh-dot:approved-executor',
      order: 26,
      text: [
        'You are a DSH Dot approved execution worker.',
        'The user approved exactly one action. Perform it with the approved tools only.',
        'Do not create tasks, propose actions, approve anything, or ask for approval.',
        'Do not expand the scope or invent external actions.',
        'Report the concrete result and verification.',
      ].join('\n'),
    })
    const allowed = new Set([...SUPPORT_TOOLS, ...proposal.executionTools])
    try {
      agentCtx.tools.restrict({ allow: [...allowed] })
    } catch (error) {
      this.log('dsh-dot: executor tool restriction skipped', error)
    }
    agentCtx.tools.guard((exec: any) => {
      const name = String(exec.name ?? '')
      if (allowed.has(name)) return undefined
      return `DSH Dot approved execution is limited to: ${[...allowed].join(', ')}`
    })
    agentCtx.on('agent/status', (payload: any) => {
      if (payload?.status !== 'idle') return
      if (payload.agent?.id !== agent.id) return
      const node = this.executor
      if (!node || node.agent !== agent) return
      const result = latestAssistantText(agent, node.startSeq)
      void this.finishApprovedExecution(
        node,
        result || 'Approved execution ended without a final summary.',
        false,
      )
    })
  }

  private async finishApprovedExecution(
    node: { handle: { dispose(): Promise<void> }; agent: any; proposal: Proposal; startSeq: number; timer?: ReturnType<typeof setTimeout> } | undefined,
    result: string,
    failed: boolean,
  ): Promise<void> {
    if (node && this.executor && this.executor !== node) return
    if (node && this.executor !== node) return
    if (node?.timer) clearTimeout(node.timer)
    this.executor = undefined
    this.executingId = undefined
    const proposal = node?.proposal ?? this.store.state.proposals.find((candidate) => candidate.id === this.store.state.executingId)
    if (node) await node.handle.dispose().catch(() => {})
    if (proposal) {
      await this.store.mutate((state) => {
        proposal.status = failed ? 'failed' : 'executed'
        proposal.updatedAt = Date.now()
        proposal.executedAt = Date.now()
        proposal.result = result.slice(0, 4_000)
        state.executingId = undefined
      })
      await this.recordProposalTaskEvent(proposal, failed ? 'failed' : 'executed', result)
      this.queueTaskNotice(
        `Approved execution ${failed ? 'failed' : 'completed'}: ${proposal.title}\n${result.slice(0, 900)}\nReview the task and tell the user the next step.`,
      )
      this.injectNotice(
        `${failed ? 'Execution failed' : 'Execution completed'}: ${proposal.title}\n${result.slice(0, 900)}`,
        'Dot execution result',
      )
    }
    setTimeout(() => {
      if (!this.disposed) this.kickExecution()
    }, 250).unref?.()
  }

  private executionEventCount(agent: any): number {
    try {
      return agent?.session?.snapshotEvents?.().length ?? 0
    } catch {
      return 0
    }
  }

  private async executeProposal(proposal: Proposal): Promise<void> {
    await this.ready
    if (!this.agent || !this.dotCtx) return
    if (this.agent.status !== 'idle') return
    this.executingId = proposal.id
    try {
      this.executionStartSeq = this.agent.session.snapshotEvents().length
    } catch {
      this.executionStartSeq = 0
    }
    this.applyExecutionRestriction(this.dotCtx, this.agent, proposal)
    const missingTools = proposal.executionTools.filter((tool) => !this.executionTools.has(tool))
    if (missingTools.length > 0) {
      await this.finishExecution(
        `Approved execution tools are not available in this Host: ${missingTools.join(', ')}`,
        true,
      )
      return
    }
    await this.store.mutate((state) => {
      proposal.status = 'executing'
      proposal.updatedAt = Date.now()
      state.executingId = proposal.id
      state.pendingAuto = state.pendingAuto.filter((id) => id !== proposal.id)
    })

    const instruction = [
      '[DSH Dot — approved execution]',
      `Approved action: ${proposal.proposedAction}`,
      `Original finding: ${proposal.description}`,
      `Evidence: ${proposal.evidence || '(none provided)'}`,
      `Approved execution tools: ${proposal.executionTools.join(', ') || '(none)'}`,
      `Instruction: ${proposal.executionInstruction || proposal.proposedAction}`,
      'Execute only this action. Do not invent new external actions. Do not send, publish, pay, delete, or change an account unless that exact action was approved.',
      'When finished, report the concrete result, including files changed or the exact reason it could not be completed.',
    ].join('\n')

    try {
      this.agent.followup(noticeMessage(instruction, 'Dot approved execution'))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.finishExecution(message, true)
    }
  }

  private async recordProposalTaskEvent(
    proposal: Proposal,
    decision: 'approved' | 'rejected' | 'executed' | 'failed',
    detail: string,
  ): Promise<void> {
    if (!proposal.taskId) return
    try {
      await this.tasks.recordProposalDecision(
        proposal.taskId,
        proposal.id,
        decision,
        decision === 'failed' ? 'Proposal execution failed' : `Proposal ${decision}`,
        detail,
      )
    } catch (error) {
      this.log('dsh-dot: could not record proposal task event', error)
    }
  }

  private queueTaskNotice(text: string): void {
    this.taskNotices.push(text)
    if (this.agent && this.agent.status !== 'running') void this.flushTaskNotices()
  }

  private async flushTaskNotices(): Promise<void> {
    if (this.taskNoticeBusy || this.taskNotices.length === 0) return
    if (!this.agent || this.agent.status === 'running') return
    const text = this.taskNotices.shift()
    if (!text) return
    this.taskNoticeBusy = true
    try {
      this.agent.followup(noticeMessage(text, 'Dot task notice'))
    } catch (error) {
      this.lastDeliveryError = error instanceof Error ? error.message : String(error)
      this.log('dsh-dot: could not deliver task notice', error)
    } finally {
      this.taskNoticeBusy = false
    }
  }

  private handleWorkerEvent(event: WorkerEvent): void {
    if (event.kind !== 'idle' && event.kind !== 'failed' && event.kind !== 'cancelled') return
    this.workerEvents.push(event)
    void this.coordinator.pump()
    if (this.agent && this.agent.status !== 'running') void this.flushWorkerEvents()
  }

  private async flushWorkerEvents(): Promise<void> {
    if (this.workerEventBusy || this.workerEvents.length === 0) return
    if (!this.agent || this.agent.status === 'running') return
    const event = this.workerEvents.shift()
    if (!event) return
    this.workerEventBusy = true
    try {
      this.agent.followup(noticeMessage(formatWorkerEvent(event), 'Dot worker event'))
    } catch (error) {
      this.lastDeliveryError = error instanceof Error ? error.message : String(error)
      this.log('dsh-dot: could not deliver worker event', error)
    } finally {
      this.workerEventBusy = false
    }
  }

  private async onIdle(agent: any): Promise<void> {
    // One turn boundary = the Agent went idle. A reply always quotes the message
    // that woke its own turn, never a stale one from a previous turn.
    this.wakeMessageId = undefined
    await this.store.ensureLoaded()
    if (this.config.orchestrator && this.executingId) {
      // The executor owns this proposal in a separate Agent; never attribute
      // the supervisor's idle turn to the approved execution.
      await this.flushWorkerEvents()
      await this.flushTaskNotices()
      return
    }
    if (this.executingId) {
      const text = latestAssistantText(agent, this.executionStartSeq)
      await this.finishExecution(
        text || 'Execution turn ended without a final assistant summary. Verify the target path.',
        false,
      )
      this.executionStartSeq = 0
      void this.flushWorkerEvents()
      void this.flushTaskNotices()
      return
    }

    if (this.config.orchestrator) {
      await this.flushWorkerEvents()
      await this.flushTaskNotices()
      void this.autologMemory()
      if (this.store.state.pendingAuto.length > 0) this.kickExecution()
      return
    }

    await this.store.mutate((state) => {
      state.lastResearchCompletedAt = Date.now()
      delete state.lastError
    })
    if (this.store.state.pendingAuto.length > 0) this.kickExecution()
  }

  private async finishExecution(result: string, failed: boolean): Promise<void> {
    const id = this.executingId
    if (!id) return
    const proposal = this.store.state.proposals.find((candidate) => candidate.id === id)
    await this.store.mutate((state) => {
      if (proposal) {
        proposal.status = failed ? 'failed' : 'executed'
        proposal.updatedAt = Date.now()
        proposal.executedAt = Date.now()
        proposal.result = result.slice(0, 4000)
      }
      state.executingId = undefined
    })
    this.executingId = undefined
    this.executionStartSeq = 0
    this.executionTools = new Set()
    this.restoreResearchRestriction()
    if (proposal?.taskId) {
      await this.recordProposalTaskEvent(proposal, failed ? 'failed' : 'executed', result)
      this.queueTaskNotice(
        `Proposal ${failed ? 'failed' : 'executed'}: ${proposal.title}\n${result.slice(0, 900)}\nReview the task and tell the user the next step.`,
      )
    }
    this.injectNotice(
      `${failed ? 'Execution failed' : 'Execution completed'}: ${proposal?.title ?? id}\n${result.slice(0, 900)}`,
      'Dot execution result',
    )
    // Let the user see the finished card before another approved action starts.
    setTimeout(() => {
      if (!this.disposed) this.kickExecution()
    }, 250).unref?.()
  }


  async assignWorker(taskId: string, brief: string): Promise<AssignResult> {
    const result = await this.coordinator.request(taskId, brief)
    if (result.queued) {
      const busy = (result.activeTasks ?? []).map((task) => `"${task.title}"`).join(', ') || 'nothing visible'
      const ask = result.suggestScaleUp
        ? ' It also looks unrelated to the running work. Say in one or two plain sentences that everyone is busy, then ask whether to add one permanent slot. Call dot_set_worker_limit with delta: 1 only after the user clearly agrees.'
        : ' Tell the user in one short sentence what this task is waiting behind. Do not ask for a new slot.'
      this.queueTaskNotice(
        `[Dot capacity] Task "${result.taskTitle}" is queued; all ${result.workerLimit} worker slots are busy (${busy}).${ask} If you already covered this in the current turn, ignore this note.`,
      )
    }
    return result
  }

  async workerCapacity(): Promise<CapacityView> {
    await this.ready.catch(() => {})
    await this.limits.ensureLoaded()
    return { ...this.coordinator.capacityView(), source: this.limits.source }
  }

  async setWorkerLimit(input: { limit?: number; delta?: number; reason?: string }): Promise<Record<string, unknown>> {
    await this.ready.catch(() => {})
    await this.limits.ensureLoaded()
    const hasLimit = input.limit !== undefined
    const hasDelta = input.delta !== undefined
    if (hasLimit && hasDelta) throw new Error('worker_limit_ambiguous: pass limit or delta, not both')
    if (!hasLimit && !hasDelta) throw new Error('worker_limit_required: pass limit or delta')
    const current = this.limits.limit
    const requested = hasLimit ? Number(input.limit) : current + Number(input.delta)
    if (!isWorkerLimit(requested)) {
      throw new Error(
        `worker_limit_out_of_range: ${requested} is outside ${MIN_WORKER_LIMIT}-${MAX_WORKER_LIMIT}`,
      )
    }
    const write = await this.limits.set(requested)
    this.coordinator.setLimit(write.limit)
    const startedTaskIds = await this.coordinator.pump()
    const capacity = this.coordinator.capacityView()
    return {
      limit: write.limit,
      previous: write.previous,
      changed: write.changed,
      persisted: write.persisted,
      source: 'user',
      ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
      startedTaskIds,
      activeWorkers: capacity.activeWorkers,
      queuedTasks: capacity.queuedTasks,
      ...(write.persisted
        ? {}
        : { warning: 'worker_limit_not_persisted: the new limit applies now but may reset after a restart.' }),
    }
  }

  async askWorker(workerId: string, question: string): Promise<{ ok: true }> {
    await this.workers.ask(workerId, question)
    return { ok: true }
  }

  async focusTask(taskId: string): Promise<DotTaskV2> {
    await this.coordinator.focus(taskId)
    const task = this.store.state.tasks.find((candidate) => candidate.id === taskId)
    if (!task) throw new Error(`task_not_found: ${taskId}`)
    return task
  }

  async appendChat(role: 'user' | 'assistant', text: string): Promise<DotChatMessage> {
    await this.store.ensureLoaded()
    const clean = text.trim().slice(0, 8_000)
    if (!clean) throw new Error('message text is required')
    const message: DotChatMessage = {
      id: `chat_${randomUUID()}`,
      role,
      text: clean,
      at: Date.now(),
    }
    await this.store.mutate((state) => {
      state.chatMessages.push(message)
      if (state.chatMessages.length > 200) state.chatMessages = state.chatMessages.slice(-200)
    })
    return message
  }

  async appendDotSay(text: string, replyTo?: string): Promise<DotChatMessage> {
    const clean = text.trim()
    if (replyTo && clean) {
      // Quote metadata is optional in this version; keep the reply itself.
    }
    return this.appendChat('assistant', text)
  }

  async sendUserChat(text: string): Promise<{ ok: true; message: DotChatMessage }> {
    await this.ready
    if (!this.agent) throw new Error('Dot Agent is not ready')
    const message = await this.appendChat('user', text)
    const prompt = [
      '[Dot user message]',
      message.text,
      'Respond to the user in the Dot chat using dot_say. First acknowledge briefly and say what you will do; then delegate. Do not wait until the work is finished to acknowledge.',
    ].join('\n')
    const notice = noticeMessage(prompt, 'Dot user message')
    if (this.agent.status === 'running') this.agent.inject(notice)
    else this.agent.followup(notice)
    const seq = ++this.chatRecoverySeq
    setTimeout(() => void this.recoverChatIfSilent(seq, message.at), 3_000).unref?.()
    return { ok: true, message }
  }

  private async recoverChatIfSilent(seq: number, at: number): Promise<void> {
    if (seq !== this.chatRecoverySeq || !this.agent) return
    if (this.agent.status === 'running') return
    const answered = this.store.state.chatMessages.some(
      (message) => message.role === 'assistant' && message.at > at,
    )
    if (answered) return
    this.log('dsh-dot: chat Agent did not wake; starting a fresh internal manager')
    const old = this.handle
    this.handle = undefined
    this.agent = undefined
    this.dotCtx = undefined
    try {
      await old?.dispose()
    } catch (error) {
      this.log('dsh-dot: could not dispose stale chat Agent', error)
    }
    try {
      await this.create()
      this.wakeMessageId = this.store.state.chatMessages.filter((message) => message.role === 'user').slice(-1)[0]?.id
      const history = this.store.state.chatMessages
        .slice(-10)
        .map((message) => `${message.role === 'user' ? 'User' : 'Dot'}: ${message.text}`)
        .join('\n')
      this.agent?.followup(
        noticeMessage(
          `[Dot custom chat]\n${history}\n\nRespond to the latest user message using dot_say. First acknowledge briefly and say what you will do.`,
          'Dot custom chat recovery',
        ),
      )
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.log('dsh-dot: could not start a fresh chat manager', error)
    }
  }

  async addTask(goal: string, nextStep = ''): Promise<DotTaskV2> {
    await this.store.ensureLoaded()
    const task = makeTask(goal, nextStep)
    await this.store.mutate((state) => {
      state.tasks.unshift(task)
      state.tasks = state.tasks.slice(0, 50)
      if (!state.focusedTaskId) state.focusedTaskId = task.id
    })
    return task
  }

  async updateTask(
    taskId: string,
    patch: { progress?: string; nextStep?: string; status?: 'active' | 'done' },
  ): Promise<DotTaskV2 | undefined> {
    await this.store.ensureLoaded()
    const task = this.store.state.tasks.find((candidate) => candidate.id === taskId)
    if (!task) return undefined
    await this.store.mutate(() => {
      const now = Date.now()
      if (typeof patch.progress === 'string' && patch.progress !== task.plan) {
        task.plan = patch.progress
        appendTaskEvent(task, makeTaskEvent('dot', 'worker_progress', 'Progress updated', patch.progress, now))
      }
      if (typeof patch.nextStep === 'string') task.nextAction = patch.nextStep
      if (patch.status === 'active') {
        if (!['done', 'cancelled', 'running', 'coordinating', 'planned'].includes(task.status)) {
          transitionTask(task, 'planned', 'Task marked active', { now })
        }
      } else if (patch.status === 'done') {
        if (task.status !== 'done' && task.status !== 'cancelled') {
          task.verifiedResult = patch.progress?.trim() || task.verifiedResult || task.plan || 'Completed by Dot.'
          transitionTask(task, 'done', 'Task marked done', { now })
        }
      }
      task.updatedAt = Math.max(task.updatedAt, now)
    })
    return task
  }

  async registerTrigger(input: {
    source: string
    condition: string
    instruction: string
  }): Promise<DotTrigger> {
    await this.store.ensureLoaded()
    const trigger: DotTrigger = {
      id: `trigger_${randomUUID()}`,
      source: input.source.trim(),
      condition: input.condition.trim(),
      instruction: input.instruction.trim(),
      createdAt: Date.now(),
      enabled: true,
    }
    await this.store.mutate((state) => {
      state.triggers.unshift(trigger)
      state.triggers = state.triggers.slice(0, 50)
    })
    return trigger
  }

  /** Local event entry point: neither a Tool nor a webhook can execute an action directly. */
  async fireTrigger(
    triggerId: string,
    payload: unknown,
  ): Promise<{ fired: boolean; reason?: string; taskId?: string }> {
    await this.store.ensureLoaded()
    const trigger = this.store.state.triggers.find((candidate) => candidate.id === triggerId)
    if (!trigger) return { fired: false, reason: 'trigger_not_found' }
    if (!trigger.enabled) return { fired: false, reason: 'trigger_disabled' }
    if (!this.agent) return { fired: false, reason: 'agent_not_ready' }

    const text = safeJson(payload)
    if (!conditionMatches(trigger.condition, text)) {
      return { fired: false, reason: 'condition_not_matched' }
    }

    await this.store.mutate(() => {
      trigger.lastFiredAt = Date.now()
    })

    if (this.config.orchestrator) {
      try {
        const created = await this.tasks.create({
          title: `Event: ${trigger.source}`,
          request: trigger.instruction,
          nextAction: 'Review the trigger payload and assign a worker if needed.',
          plan: `Trigger ${trigger.condition} fired for ${trigger.source}.`,
        })
        await this.store.mutate((state) => {
          const task = state.tasks.find((candidate) => candidate.id === created.task.id)
          if (!task) return
          appendTaskEvent(
            task,
            makeTaskEvent('system', 'created', 'Event trigger created a task', text.slice(0, 2_000)),
          )
        })
        this.queueTaskNotice(
          `Trigger fired: ${trigger.source}/${trigger.condition}\nTask: ${created.task.title} (${created.task.id})\nPayload: ${text.slice(0, 900)}\nReview the task and assign a worker if appropriate.`,
        )
        return { fired: true, taskId: created.task.id }
      } catch (error) {
        return { fired: false, reason: error instanceof Error ? error.message : String(error) }
      }
    }

    const prompt = [
      'DSH Dot event trigger.',
      `Source: ${trigger.source}`,
      `Condition: ${trigger.condition}`,
      `Payload: ${text.slice(0, 5000)}`,
      `Instruction: ${trigger.instruction}`,
      'Investigate only with read-only tools. If this needs action, propose it with dot_propose_action. Do not execute writes in research mode.',
    ].join('\n')
    try {
      const message = noticeMessage(prompt, 'Dot event trigger')
      if (this.agent.status === 'running') this.agent.inject(message)
      else this.agent.followup(message)
      return { fired: true }
    } catch (error) {
      return { fired: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  async scheduleTask(input: {
    title: string
    prompt: string
    cronExpression?: string
    everySeconds?: number
    timeZone?: string
  }): Promise<Record<string, unknown>> {
    await this.ready
    if (!this.agent) throw new Error('Dot Agent is not ready')
    const schedule = this.ctx.get?.('schedule')
    if (!schedule) throw new Error('the schedule service is unavailable')
    const prompt = this.config.orchestrator
      ? [
          '[DSH Dot scheduled task]',
          `Create or update one task: ${input.title}`,
          `Instruction: ${input.prompt}`,
          'Use dot_create_task if no matching task exists. Assign a worker only if the task is concrete; do not execute real writes without user approval.',
        ].join('\n')
      : input.prompt
    if (input.cronExpression) {
      return await schedule.create(String(this.agent.id), {
        title: input.title,
        prompt,
        cron: {
          expression: input.cronExpression,
          time_zone: input.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        },
      })
    }
    if (!input.everySeconds || input.everySeconds < 60) {
      throw new Error('every_seconds must be at least 60')
    }
    return await schedule.create(String(this.agent.id), {
      title: input.title,
      prompt,
      every_seconds: input.everySeconds,
    })
  }

  async listSchedules(): Promise<ScheduleView[]> {
    await this.ready.catch(() => {})
    const schedule = this.ctx.get?.('schedule')
    if (!schedule || !this.agent) return []
    try {
      const records = (await schedule.list({ sessionId: String(this.agent.id) })) as any[]
      return records.map((record) => ({
        id: String(record.id),
        title: String(record.title ?? record.prompt ?? 'Scheduled task'),
        kind: String(record.kind ?? 'schedule'),
        detail:
          record.kind === 'cron'
            ? `cron ${String(record.expression)} (${String(record.timeZone)})`
            : record.kind === 'every'
              ? `every ${String(record.everySeconds)}s`
              : String(record.scheduledAt ?? ''),
        scheduledAt: typeof record.scheduledAt === 'string' ? record.scheduledAt : undefined,
      }))
    } catch {
      return []
    }
  }

  async getClientState(): Promise<ClientState> {
    await this.ready.catch(() => {})
    const state = this.store.state
    return {
      ok: true,
      version: 2,
      enabled: this.config.enabled,
      dotSessionId: this.sessionId ?? state.dotSessionId,
      agentStatus: this.agent?.status,
      lastDeliveryError: this.lastDeliveryError,
      dotStatus: this.lastError && !this.agent
        ? 'error'
        : this.agent?.status === 'running'
          ? 'running'
          : this.initialized
            ? 'idle'
            : 'starting',
      sources: this.config.sources.filter((source) => source.enabled !== false),
      proposals: state.proposals.slice().sort((left, right) => right.createdAt - left.createdAt),
      tasks: state.tasks.slice(),
      workers: state.workers.slice(),
      chatMessages: state.chatMessages.slice(),
      focusedTaskId: state.focusedTaskId,
      triggers: state.triggers.slice(),
      schedules: await this.listSchedules(),
      lastResearchAt: state.lastResearchAt,
      lastResearchCompletedAt: state.lastResearchCompletedAt,
      lastError: state.lastError ?? this.lastError,
      executionTools: this.config.executionTools,
    }
  }

  getScopedState(): Record<string, unknown> {
    const state = this.store.state
    return {
      proposals: state.proposals.slice(0, 20).map((proposal) => ({
        id: proposal.id,
        title: proposal.title,
        status: proposal.status,
        risk: proposal.risk,
      })),
      tasks: state.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        request: task.request,
        plan: task.plan,
        nextAction: task.nextAction,
        status: task.status,
      })),
      triggers: state.triggers.map((trigger) => ({
        id: trigger.id,
        source: trigger.source,
        condition: trigger.condition,
        instruction: trigger.instruction,
      })),
      dotSessionId: this.sessionId,
      dotStatus: this.agent?.status ?? 'starting',
    }
  }

  private injectNotice(text: string, summary: string): void {
    if (!this.agent) return
    try {
      this.agent.inject(noticeMessage(text, summary))
    } catch (error) {
      this.log('dsh-dot: could not inject notice', error)
    }
  }

  private buildResearchPrompt(): string {
    const sources = this.config.sources
      .filter((source) => source.enabled !== false)
      .map((source) => {
        if (source.kind === 'directory') {
          return `- ${source.label}: directory at ${source.path}. Use glob and read.`
        }
        if (source.kind === 'url') {
          return `- ${source.label}: ${source.url}. Use web_fetch.`
        }
        return `- ${source.label}: MCP tools ${(source.tools ?? []).join(', ') || '(none listed)'}.`
      })
      .join('\n')

    const outbox = this.outboxPath()
    const activeTasks = this.store.state.tasks.filter(
      (task) => task.status !== 'done' && task.status !== 'cancelled',
    )
    const existingProposals = this.store.state.proposals.slice(0, 8)
    const proposalLines = existingProposals.length > 0
      ? [
          'Existing proposals (do not duplicate these):',
          ...existingProposals.map(
            (proposal) => `- [${proposal.status}] ${proposal.title} (${proposal.actionType})`,
          ),
        ]
      : []
    const taskLines = activeTasks.length > 0
      ? [
          'Active tracked tasks:',
          ...activeTasks.map(
            (task) =>
              `- ${task.title} | status: ${task.status} | plan: ${task.plan} | next: ${task.nextAction} | id: ${task.id}`,
          ),
          'If a tracked task has a safe, concrete next step, propose it. Do not invent progress.',
        ]
      : []
    return [
      'DSH Dot research round.',
      `Current time: ${new Date().toISOString()}`,
      `Dot workspace: ${this.cwd()}`,
      'Read-only sources:',
      sources,
      ...proposalLines,
      ...taskLines,
      `Read-only tools available: ${[...this.researchTools].join(', ') || '(none)'}.`,
      `Execution tools available after approval: ${this.config.executionTools.join(', ') || '(none)'}.`,
      outbox ? `For a reply or draft to a local inbox item, the outbox directory is: ${outbox}` : '',
      'Investigate only the listed sources now. Do not recursively inspect node_modules, .archive, or the plugin source tree.',
      'You may use only the read-only tools listed above; any write will be denied.',
      `Find at most ${this.config.maxProposalsPerRound} concrete, useful actions. Do not invent work.`,
      'For each action worth doing, call dot_propose_action with a short title, why it matters, the evidence, the exact proposed outcome, execution_tools, and an execution_instruction containing the exact target path or recipient.',
      'For files, execution_tools should be ["write"] and the instruction must name an absolute output path.',
      'If a source explicitly asks for a recurring check, a long-running goal, or an event trigger, use dot_schedule_task / dot_add_task / dot_register_trigger directly. These are internal Dot bookkeeping, not external actions. Do not invent schedules or tasks.',
      'If a tracked task has a verifiable next step in the sources, call dot_update_task with evidence-based progress. Never mark it done without evidence.',
      'Do not propose sending, publishing, paying, deleting, or changing an account in this round. Propose a draft or a preparatory step instead.',
      'If nothing is worth doing, reply exactly: No action needed.',
      'End with a short summary of what you checked and what you proposed.',
    ]
      .filter((line) => line !== '')
      .join('\n')
  }

  private outboxPath(): string {
    const directorySource = this.config.sources.find(
      (source) => source.kind === 'directory' && source.path,
    )
    if (!directorySource?.path) return ''
    return path.resolve(directorySource.path, '..', 'outbox')
  }

  private async refreshMemory(): Promise<void> {
    try {
      await this.memory.store.ensureReady()
      await this.memory.index.refresh()
      this.memoryDigest = await buildStartupDigest(this.memory.store, this.memory.index)
    } catch (error) {
      this.memoryDigest = ''
      this.log('dsh-dot memory: startup digest unavailable', error)
    }
  }

  private async wakeSnapshot(): Promise<string> {
    try {
      const snapshot = buildWakeSnapshot(this.memory.store)
      const timeout = new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve(''), 50)
        timer.unref?.()
      })
      return await Promise.race([snapshot, timeout])
    } catch (error) {
      this.log('dsh-dot memory: wake snapshot unavailable', error)
      return ''
    }
  }

  private async autologMemory(): Promise<void> {
    try {
      await autologTasks(this.store.state, this.memory.store, this.log)
    } catch (error) {
      this.log('dsh-dot memory: autolog failed', error)
    }
  }

  private validateMemorySource(source: string): boolean {
    const colon = source.indexOf(':')
    if (colon <= 0) return false
    const kind = source.slice(0, colon)
    const id = source.slice(colon + 1)
    if (!id) return false
    if (kind === 'task') return this.store.state.tasks.some((task) => task.id === id)
    if (kind === 'worker') return this.store.state.workers.some((worker) => worker.id === id)
    if (kind === 'chat') return this.store.state.chatMessages.some((message) => message.id === id)
    if (kind === 'journal') return /^journal\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}\.md(#[0-9]+)?$/.test(id)
    return false
  }

  private cwd(): string {
    if (this.config.dotWorkspace) return path.resolve(this.config.dotWorkspace)
    const workingDirectory = this.ctx.get?.('workingDirectory')?.defaultDirectory
    return path.resolve(workingDirectory || process.cwd())
  }

  private agentOptions(): { provider?: string; model?: string } {
    const selection = this.ctx.get?.('agentDefaultModel')?.currentSelection?.()
    if (!selection?.provider || !selection?.model) return {}
    return { provider: selection.provider, model: selection.model }
  }

  private setTitle(): void {
    if (!this.agent) return
    try {
      this.ctx.get?.('sessionTitle')?.rename?.(this.agent.session, 'Dot')
    } catch (error) {
      this.log('dsh-dot: could not set the Dot Session title', error)
    }
  }
}

function availableTools(ctx: AnyContext, requested: string[], agent?: any): Set<string> {
  const schemas = agent
    ? ctx.tools.schemas?.(agent) ?? ctx.tools.schemas?.() ?? []
    : ctx.tools.schemas?.() ?? []
  const available = new Set<string>(schemas.map((schema: any) => String(schema.name)))
  return new Set(requested.filter((name) => available.has(name)))
}

function normalizeExecutionTools(requested: string[], allowed: string[]): string[] {
  const allowedSet = new Set(allowed)
  const tools = [...new Set(requested)]
  for (const tool of tools) {
    if (!allowedSet.has(tool)) {
      throw new Error(`execution tool "${tool}" is not in the configured executionTools`)
    }
  }
  return tools
}

function validateProposalInput(args: any): ProposalInput {
  const title = text(args?.title, 'title', 160)
  const description = text(args?.description, 'description', 2000)
  const proposedAction = text(args?.proposed_action, 'proposed_action', 2000)
  const actionType = text(args?.action_type, 'action_type', 80)
  const source = typeof args?.source === 'string' ? args.source.slice(0, 200) : 'research'
  const evidence = typeof args?.evidence === 'string' ? args.evidence.slice(0, 2000) : ''
  const executionTools = Array.isArray(args?.execution_tools)
    ? args.execution_tools.filter((tool: unknown): tool is string => typeof tool === 'string')
    : []
  const executionInstruction =
    typeof args?.execution_instruction === 'string'
      ? args.execution_instruction.slice(0, 2000)
      : ''
  return {
    ...(typeof args?.task_id === 'string' && args.task_id.trim() ? { taskId: args.task_id.trim() } : {}),
    title,
    description,
    proposedAction,
    actionType,
    source,
    evidence,
    executionTools,
    executionInstruction,
  }
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value.trim().slice(0, max)
}

function noticeMessage(text: string, summary: string): Record<string, unknown> {
  return {
    id: `dot-notice-${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'dsh-dot', form: 'notice', summary },
  }
}

function recentUserChatContext(messages: DotChatMessage[], currentId: string): string[] {
  const recent = messages
    .filter((message) => message.role === 'user' && message.id !== currentId)
    .slice(-4)
  if (recent.length === 0) return []
  return [
    'Earlier user messages you may quote with dot_say reply_to:',
    ...recent.map(
      (message) => `- ${message.id}: ${message.text.replace(/\s+/g, ' ').slice(0, 80)}`,
    ),
  ]
}

function formatWorkerEvent(event: WorkerEvent): string {
  const lines = [
    '[Dot worker event]',
    `Task: ${event.taskTitle} (${event.taskId})`,
    `Worker: ${event.workerId}`,
    `Kind: ${event.kind}`,
  ]
  if (event.result) lines.push(`Result: ${event.result.slice(0, 4000)}`)
  if (event.error) lines.push(`Error: ${event.error.slice(0, 1000)}`)
  lines.push(
    event.kind === 'idle'
      ? 'Review the result, update the task, and tell the user the next step. Do not claim completion without evidence.'
      : 'Report the blocker to the user and keep other tasks moving.',
  )
  return lines.join('\n')
}

function latestAssistantText(agent: any, startIndex = 0): string {
  try {
    const events = agent.session?.snapshotEvents?.() ?? []
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
    // Disposed sessions may no longer be readable.
  }
  return ''
}


function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return String(value)
  }
}

function conditionMatches(condition: string, text: string): boolean {
  const trimmed = condition.trim()
  if (!trimmed || trimmed === '*') return true
  try {
    return new RegExp(trimmed, 'i').test(text)
  } catch {
    return text.toLowerCase().includes(trimmed.toLowerCase())
  }
}


function proposalFingerprint(input: {
  taskId?: string
  actionType: string
  title: string
  proposedAction: string
  executionInstruction: string
}): string {
  const text = [input.taskId ?? '', input.actionType, input.title, input.proposedAction, input.executionInstruction]
    .join('\n')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .trim()
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}
