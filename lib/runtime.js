import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { registerDotTools } from './tools.js';
import { appendTaskEvent, makeTask, makeTaskEvent, transitionTask } from './tasks.js';
import { SUPERVISOR_PERSONA } from './orchestrator/supervisor.js';
import { TaskService } from './orchestrator/task-service.js';
import { WorkerManager } from './orchestrator/worker-manager.js';
import { Coordinator } from './orchestrator/coordinator.js';
const SUPPORT_TOOLS = ['read', 'glob', 'grep'];
const PERSONA = [
    'You are Dot, a persistent proactive agent working inside DeepSeek Harness.',
    'Your job is to inspect the user’s configured read-only sources, find concrete work that would help, and propose it.',
    'During research you have only read-only tools. Never claim to have changed, sent, deleted, or published anything.',
    'When you find an action worth taking, call dot_propose_action. State the evidence, the exact outcome, the execution tools, and the target path or recipient.',
    'You cannot approve your own proposals. The user approves or rejects them in the DSH Dot panel.',
    'When the user approves a proposal, you will be woken in execution mode with exactly the approved tools. Execute only that action, then report the real result.',
    'If nothing is worth doing, say so briefly. Prefer silence over invented work.',
    'Do not invent sources. Only inspect the sources listed in the research prompt.',
].join('\n');
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
    ctx;
    config;
    store;
    reviewer;
    log;
    ready;
    agent;
    handle;
    dotCtx;
    disposed = false;
    initialized = false;
    lastError;
    lastDeliveryError;
    chatRecoverySeq = 0;
    researchRestriction;
    executionRestriction;
    researchTools = new Set();
    executionTools = new Set();
    tasks;
    workers;
    coordinator;
    workerEvents = [];
    workerEventBusy = false;
    taskNotices = [];
    taskNoticeBusy = false;
    executingId;
    executionStartSeq = 0;
    executor;
    proposalsThisRound = 0;
    startedAt = Date.now();
    constructor(ctx, config, store, reviewer, log = () => { }) {
        this.ctx = ctx;
        this.config = config;
        this.store = store;
        this.reviewer = reviewer;
        this.log = log;
        this.tasks = new TaskService(store, log);
        this.workers = new WorkerManager({
            ctx,
            config: this.config,
            store,
            workspace: this.cwd(),
            getSupervisor: () => this.agent,
            agentOptions: this.agentOptions(),
            onEvent: (event) => this.handleWorkerEvent(event),
            log,
        });
        this.coordinator = new Coordinator({
            store,
            tasks: this.tasks,
            workers: this.workers,
            maxWorkers: this.config.maxWorkers,
            log,
        });
        this.ready = this.initialize().catch((error) => {
            this.lastError = error instanceof Error ? error.message : String(error);
            this.log('dsh-dot: Dot Agent initialization failed', error);
        });
    }
    /** Register the Agent lifecycle and the research heartbeat. */
    start() {
        this.ctx.effect(() => {
            return async () => {
                this.disposed = true;
                await this.ready.catch(() => { });
                if (this.executor) {
                    if (this.executor.timer)
                        clearTimeout(this.executor.timer);
                    await this.executor.handle.dispose().catch(() => { });
                    this.executor = undefined;
                }
                await this.workers.disposeAll();
                await this.handle?.dispose().catch((error) => {
                    this.log('dsh-dot: Dot Agent disposal failed', error);
                });
            };
        }, 'dsh-dot: Dot Agent lifecycle');
        this.ctx.effect(() => {
            if (this.config.orchestrator)
                return () => { };
            let stopped = false;
            let timer;
            const schedule = (delay) => {
                if (stopped)
                    return;
                timer = setTimeout(tick, Math.max(1_000, delay));
                timer.unref?.();
            };
            const tick = async () => {
                if (stopped)
                    return;
                try {
                    await this.ready;
                    await this.runResearch('timer');
                }
                catch (error) {
                    this.lastError = error instanceof Error ? error.message : String(error);
                    this.log('dsh-dot: research heartbeat failed', error);
                }
                finally {
                    if (!stopped)
                        schedule(this.config.researchIntervalMs);
                }
            };
            void this.ready.then(() => {
                if (!stopped)
                    schedule(this.config.initialDelayMs);
            });
            return () => {
                stopped = true;
                if (timer)
                    clearTimeout(timer);
            };
        }, 'dsh-dot: research heartbeat');
    }
    get sessionId() {
        return this.agent?.id ? String(this.agent.id) : undefined;
    }
    async initialize() {
        await this.store.ensureLoaded();
        if (!this.config.enabled) {
            this.initialized = true;
            return;
        }
        await this.workers.reconcile();
        const existing = this.store.state.dotSessionId;
        if (existing) {
            try {
                await this.resume(existing);
                await this.reconcileInterruptedExecution();
                this.initialized = true;
                if (this.store.state.pendingAuto.length > 0)
                    setTimeout(() => this.kickExecution(), 250).unref?.();
                return;
            }
            catch (error) {
                this.log(`dsh-dot: could not resume Dot Session "${existing}"; creating a new one`, error);
            }
        }
        await this.create();
        await this.reconcileInterruptedExecution();
        this.initialized = true;
        if (this.store.state.pendingAuto.length > 0)
            setTimeout(() => this.kickExecution(), 250).unref?.();
    }
    async resume(sessionId) {
        const handle = await this.ctx.agents.resume({
            resumeSessionId: sessionId,
            agentOptions: this.agentOptions(),
            setup: (agentCtx, agent) => this.configureAgent(agentCtx, agent),
        });
        await this.attach(handle);
    }
    async create() {
        const sessionId = `session-dot-${randomUUID()}`;
        const handle = await this.ctx.agents.create({
            sessionId,
            meta: { cwd: this.cwd(), origin: 'subagent' },
            agentOptions: this.agentOptions(),
            setup: (agentCtx, agent) => this.configureAgent(agentCtx, agent),
        });
        await this.attach(handle);
    }
    async attach(handle) {
        if (this.disposed) {
            await handle.dispose().catch(() => { });
            return;
        }
        this.handle = handle;
        this.agent = handle.agent;
        this.setTitle();
        await this.store.mutate((state) => {
            state.dotSessionId = String(handle.agent.id);
            delete state.lastError;
        });
    }
    async configureAgent(agentCtx, agent) {
        this.dotCtx = agentCtx;
        // Bind the requested Agent preset before our own scoped tools. The preset
        // supplies the real read-only tool set (read/glob/grep/web) and the
        // standard approval/sandbox behavior.
        const presets = this.ctx.get?.('agentPresets');
        if (presets?.mount) {
            try {
                await presets.mount(agentCtx, this.config.agentPreset || undefined);
            }
            catch (error) {
                this.lastError = `Agent preset "${this.config.agentPreset}" failed to mount: ${error instanceof Error ? error.message : String(error)}`;
                this.log('dsh-dot: Agent preset mount failed', error);
            }
        }
        else {
            this.lastError = 'agentPresets service unavailable; Dot research tools are not composed';
        }
        agentCtx.systemPrompt.section({
            name: 'dsh-dot:persona',
            order: 25,
            text: this.config.orchestrator ? SUPERVISOR_PERSONA : PERSONA,
        });
        registerDotTools(agentCtx, this, agent, this.config.orchestrator);
        // Monotonic guard: a phase change can only narrow or replace the set of
        // callable global tools. It is scoped to this Agent, not the user Session.
        agentCtx.tools.guard((exec) => {
            const name = String(exec.name ?? '');
            if (name.startsWith('dot_'))
                return undefined;
            if (this.config.orchestrator) {
                return `DSH Dot supervisor delegates work to workers. Tool "${name}" is not available in the supervisor.`;
            }
            const allowed = this.executingId
                ? this.executionTools
                : this.researchTools;
            if (allowed.has(name))
                return undefined;
            return this.executingId
                ? `DSH Dot execution is limited to the approved tools: ${[...allowed].join(', ') || '(none)'}`
                : `DSH Dot research is read-only. Tool "${name}" is not allowed.`;
        });
        this.applyResearchRestriction(agentCtx, agent);
        agentCtx.on('agent/status', (payload) => {
            if (payload?.status !== 'idle')
                return;
            if (payload.agent?.id !== agent.id)
                return;
            void this.onIdle(agent);
        });
    }
    applyResearchRestriction(agentCtx, agent) {
        this.researchRestriction?.();
        this.researchRestriction = undefined;
        this.researchTools = this.config.orchestrator
            ? new Set()
            : availableTools(this.ctx, this.config.readOnlyTools, agent);
        if (this.config.orchestrator) {
            try {
                this.researchRestriction = agentCtx.tools.restrict({ allow: [] });
            }
            catch (error) {
                this.log('dsh-dot: supervisor tool restriction skipped', error);
            }
            return;
        }
        if (this.researchTools.size > 0) {
            try {
                this.researchRestriction = agentCtx.tools.restrict({ allow: [...this.researchTools] });
            }
            catch (error) {
                // Preset-scoped tools may not be visible to the global restriction
                // filter. The monotonic guard below remains authoritative.
                this.log('dsh-dot: global tool restriction skipped', error);
            }
        }
    }
    applyExecutionRestriction(agentCtx, agent, proposal) {
        this.researchRestriction?.();
        this.researchRestriction = undefined;
        this.executionRestriction?.();
        this.executionRestriction = undefined;
        this.executionTools = availableTools(this.ctx, [
            ...SUPPORT_TOOLS,
            ...proposal.executionTools,
        ], agent);
        if (this.executionTools.size > 0) {
            try {
                this.executionRestriction = agentCtx.tools.restrict({ allow: [...this.executionTools] });
            }
            catch (error) {
                this.log('dsh-dot: execution tool restriction skipped', error);
            }
        }
    }
    restoreResearchRestriction() {
        this.executionRestriction?.();
        this.executionRestriction = undefined;
        if (this.dotCtx && this.agent)
            this.applyResearchRestriction(this.dotCtx, this.agent);
    }
    /** Mark an execution that was cut off by a Host restart instead of attributing a stale report. */
    async reconcileInterruptedExecution() {
        await this.store.ensureLoaded();
        const id = this.store.state.executingId;
        if (!id)
            return;
        await this.store.mutate((state) => {
            const proposal = state.proposals.find((candidate) => candidate.id === id);
            if (proposal) {
                proposal.status = 'failed';
                proposal.updatedAt = Date.now();
                proposal.result =
                    'The execution turn was interrupted by a Host restart. Verify the target path before retrying.';
            }
            state.executingId = undefined;
        });
    }
    /** Wake the Dot for one read-only research round. */
    async runResearch(reason) {
        if (this.config.orchestrator) {
            return { started: false, reason: 'orchestrator_not_ready' };
        }
        await this.ready;
        if (!this.config.enabled)
            return { started: false, reason: 'disabled' };
        if (!this.agent)
            return { started: false, reason: this.lastError ?? 'agent_not_ready' };
        if (this.agent.status !== 'idle')
            return { started: false, reason: 'agent_busy' };
        if (this.config.sources.filter((source) => source.enabled !== false).length === 0) {
            return { started: false, reason: 'no_sources' };
        }
        this.proposalsThisRound = 0;
        const prompt = this.buildResearchPrompt();
        await this.store.mutate((state) => {
            state.lastResearchAt = Date.now();
            delete state.lastError;
        });
        try {
            this.agent.followup(noticeMessage(prompt, 'Dot research round'));
            return { started: true, reason };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.store.mutate((state) => {
                state.lastError = message;
            });
            return { started: false, reason: message };
        }
    }
    /** Create a proposal from the Dot's scoped tool. Never executes it. */
    async proposeAction(args, signal) {
        await this.store.ensureLoaded();
        if (this.disposed)
            throw new Error('DSH Dot is disposed');
        if (!this.agent)
            throw new Error('Dot Agent is not ready');
        if (this.proposalsThisRound >= this.config.maxProposalsPerRound) {
            throw new Error(`This research round already has ${this.config.maxProposalsPerRound} proposals; wait for the next round.`);
        }
        const input = validateProposalInput(args);
        if (input.taskId) {
            const task = this.store.state.tasks.find((candidate) => candidate.id === input.taskId);
            if (!task)
                throw new Error(`task_not_found: ${input.taskId}`);
            if (task.status === 'done' || task.status === 'cancelled') {
                throw new Error(`task_not_actionable: ${task.status}`);
            }
            input.workerId = task.workerId;
        }
        const executionTools = normalizeExecutionTools(input.executionTools, this.config.executionTools);
        input.executionTools = executionTools;
        const fingerprint = proposalFingerprint(input);
        const duplicate = this.store.state.proposals.find((candidate) => proposalFingerprint(candidate) === fingerprint &&
            candidate.status !== 'rejected' &&
            candidate.status !== 'failed');
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
            };
        }
        const review = await this.reviewer.reviewProposal(input, signal);
        const rule = this.reviewer.applyRule(input);
        let decision = rule?.decision ?? 'ask';
        if (decision === 'allow') {
            // Auto-execution is opt-in and limited to genuinely low-risk proposals.
            if (!this.config.autoApproveLowRisk || review.risk !== 'low')
                decision = 'ask';
        }
        if (decision === 'ask' && rule?.decision === 'allow' && review.risk === 'high') {
            decision = 'ask';
        }
        const now = Date.now();
        const proposal = {
            id: `proposal_${randomUUID()}`,
            ...input,
            risk: review.risk,
            riskReason: review.reason,
            decision,
            status: decision === 'deny'
                ? 'rejected'
                : decision === 'allow'
                    ? 'approved'
                    : 'pending',
            createdAt: now,
            updatedAt: now,
            ...(decision === 'deny' ? { decidedAt: now } : {}),
        };
        await this.store.mutate((state) => {
            state.proposals.unshift(proposal);
            if (decision === 'allow')
                state.pendingAuto.push(proposal.id);
        });
        if (proposal.taskId) {
            await this.tasks.recordProposalCreated(proposal.taskId, proposal.id, proposal.title);
        }
        this.proposalsThisRound += 1;
        return {
            proposalId: proposal.id,
            taskId: proposal.taskId,
            status: proposal.status,
            decision,
            risk: proposal.risk,
            riskReason: proposal.riskReason,
            executionTools: proposal.executionTools,
            note: decision === 'allow'
                ? 'Policy allowed this low-risk proposal; it will run after the research turn.'
                : decision === 'deny'
                    ? 'A user rule denied this proposal.'
                    : 'Waiting for the user in the DSH Dot panel.',
        };
    }
    async approveProposal(id) {
        await this.ready;
        const proposal = this.store.state.proposals.find((candidate) => candidate.id === id);
        if (!proposal)
            return { ok: false, error: 'proposal_not_found' };
        if (proposal.status !== 'pending')
            return { ok: false, error: `proposal_is_${proposal.status}` };
        if (proposal.executionTools.length === 0) {
            await this.store.mutate(() => {
                proposal.status = 'executed';
                proposal.decision = 'allow';
                proposal.decidedAt = Date.now();
                proposal.executedAt = Date.now();
                proposal.updatedAt = Date.now();
                proposal.result = 'Approved; no execution tools were requested.';
            });
            await this.recordProposalTaskEvent(proposal, 'executed', 'Approved; no execution tools were requested.');
            this.queueTaskNotice(`Proposal executed: ${proposal.title}\nApproved without tools. Update the task and tell the user what this means.`);
            return { ok: true, proposal };
        }
        await this.store.mutate((state) => {
            proposal.decision = 'allow';
            proposal.status = 'approved';
            proposal.decidedAt = Date.now();
            proposal.updatedAt = Date.now();
            if (!state.pendingAuto.includes(proposal.id))
                state.pendingAuto.push(proposal.id);
        });
        await this.recordProposalTaskEvent(proposal, 'approved', 'User approved the proposal.');
        void this.kickExecution();
        return { ok: true, proposal };
    }
    async rejectProposal(id, note) {
        await this.ready;
        const proposal = this.store.state.proposals.find((candidate) => candidate.id === id);
        if (!proposal)
            return { ok: false, error: 'proposal_not_found' };
        if (proposal.status !== 'pending')
            return { ok: false, error: `proposal_is_${proposal.status}` };
        await this.store.mutate((state) => {
            proposal.status = 'rejected';
            proposal.decision = 'deny';
            proposal.decidedAt = Date.now();
            proposal.updatedAt = Date.now();
            if (note)
                proposal.result = `Rejected: ${note}`;
            state.pendingAuto = state.pendingAuto.filter((candidate) => candidate !== proposal.id);
        });
        await this.recordProposalTaskEvent(proposal, 'rejected', note ? `Rejected: ${note}` : 'User rejected the proposal.');
        this.injectNotice(`Action rejected by the user: ${proposal.title}${note ? `\nNote: ${note}` : ''}`, 'Dot action rejected');
        this.queueTaskNotice(`Proposal rejected: ${proposal.title}${note ? `\nReason: ${note}` : ''}\nUpdate the task and ask what the user wants next.`);
        return { ok: true, proposal };
    }
    kickExecution() {
        if (!this.agent || !this.dotCtx)
            return;
        if (this.executingId)
            return;
        if (!this.config.orchestrator && this.agent.status !== 'idle')
            return;
        const next = this.store.state.pendingAuto[0];
        if (!next)
            return;
        const proposal = this.store.state.proposals.find((candidate) => candidate.id === next && candidate.status === 'approved');
        if (!proposal) {
            void this.store.mutate((state) => {
                state.pendingAuto = state.pendingAuto.filter((id) => id !== next);
            });
            return;
        }
        if (this.config.orchestrator)
            void this.executeProposalInWorker(proposal);
        else
            void this.executeProposal(proposal);
    }
    async executeProposalInWorker(proposal) {
        await this.ready;
        if (!this.agent)
            return;
        if (this.executor || this.executingId)
            return;
        this.executingId = proposal.id;
        await this.store.mutate((state) => {
            proposal.status = 'executing';
            proposal.updatedAt = Date.now();
            state.executingId = proposal.id;
            state.pendingAuto = state.pendingAuto.filter((id) => id !== proposal.id);
        });
        let created;
        const targetTask = proposal.taskId
            ? this.store.state.tasks.find((task) => task.id === proposal.taskId)
            : undefined;
        const executorWorkspace = path.resolve(targetTask?.workspace ?? this.cwd());
        try {
            created = await this.ctx.agents.create({
                sessionId: `session-dot-executor-${randomUUID()}`,
                parentAgent: this.agent,
                meta: {
                    cwd: executorWorkspace,
                    parentSession: String(this.agent.id),
                    origin: 'subagent',
                    agentPreset: this.config.agentPreset,
                },
                agentOptions: this.agentOptions(),
                setup: (agentCtx, agent) => this.configureApprovedExecutor(agentCtx, agent, proposal),
            });
        }
        catch (error) {
            await this.finishApprovedExecution(undefined, error instanceof Error ? error.message : String(error), true);
            return;
        }
        const startSeq = this.executionEventCount(created.agent);
        const node = {
            handle: created,
            agent: created.agent,
            proposal,
            startSeq,
            timer: undefined,
        };
        this.executor = node;
        node.timer = setTimeout(() => {
            void this.finishApprovedExecution(node, 'Approved execution timed out.', true);
        }, this.config.workerTimeoutMs);
        node.timer.unref?.();
        const instruction = [
            '[DSH Dot — approved execution worker]',
            `Approved action: ${proposal.proposedAction}`,
            `Task: ${proposal.taskId ?? '(none)'}`,
            `Original finding: ${proposal.description}`,
            `Evidence: ${proposal.evidence || '(none provided)'}`,
            `Approved execution tools: ${proposal.executionTools.join(', ') || '(none)'}`,
            `Target workspace: ${executorWorkspace}`,
            `Instruction: ${proposal.executionInstruction || proposal.proposedAction}`,
            'You are the executor, not the Dot supervisor. Execute only this approved action.',
            'Do not create tasks, do not propose actions, do not ask for approval, and do not invent new external actions.',
            'Do not send, publish, pay, delete, or change an account unless that exact action was approved.',
            'When finished, report the concrete result, including files changed or the exact reason it could not be completed.',
        ].join('\n');
        try {
            await Promise.resolve(created.agent.followup(noticeMessage(instruction, 'Dot approved execution')));
        }
        catch (error) {
            await this.finishApprovedExecution(node, error instanceof Error ? error.message : String(error), true);
        }
    }
    async configureApprovedExecutor(agentCtx, agent, proposal) {
        const presets = this.ctx.get?.('agentPresets');
        if (presets?.mount)
            await presets.mount(agentCtx, this.config.agentPreset || undefined);
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
        });
        const allowed = new Set([...SUPPORT_TOOLS, ...proposal.executionTools]);
        try {
            agentCtx.tools.restrict({ allow: [...allowed] });
        }
        catch (error) {
            this.log('dsh-dot: executor tool restriction skipped', error);
        }
        agentCtx.tools.guard((exec) => {
            const name = String(exec.name ?? '');
            if (allowed.has(name))
                return undefined;
            return `DSH Dot approved execution is limited to: ${[...allowed].join(', ')}`;
        });
        agentCtx.on('agent/status', (payload) => {
            if (payload?.status !== 'idle')
                return;
            if (payload.agent?.id !== agent.id)
                return;
            const node = this.executor;
            if (!node || node.agent !== agent)
                return;
            const result = latestAssistantText(agent, node.startSeq);
            void this.finishApprovedExecution(node, result || 'Approved execution ended without a final summary.', false);
        });
    }
    async finishApprovedExecution(node, result, failed) {
        if (node && this.executor && this.executor !== node)
            return;
        if (node && this.executor !== node)
            return;
        if (node?.timer)
            clearTimeout(node.timer);
        this.executor = undefined;
        this.executingId = undefined;
        const proposal = node?.proposal ?? this.store.state.proposals.find((candidate) => candidate.id === this.store.state.executingId);
        if (node)
            await node.handle.dispose().catch(() => { });
        if (proposal) {
            await this.store.mutate((state) => {
                proposal.status = failed ? 'failed' : 'executed';
                proposal.updatedAt = Date.now();
                proposal.executedAt = Date.now();
                proposal.result = result.slice(0, 4_000);
                state.executingId = undefined;
            });
            await this.recordProposalTaskEvent(proposal, failed ? 'failed' : 'executed', result);
            this.queueTaskNotice(`Approved execution ${failed ? 'failed' : 'completed'}: ${proposal.title}\n${result.slice(0, 900)}\nReview the task and tell the user the next step.`);
            this.injectNotice(`${failed ? 'Execution failed' : 'Execution completed'}: ${proposal.title}\n${result.slice(0, 900)}`, 'Dot execution result');
        }
        setTimeout(() => {
            if (!this.disposed)
                this.kickExecution();
        }, 250).unref?.();
    }
    executionEventCount(agent) {
        try {
            return agent?.session?.snapshotEvents?.().length ?? 0;
        }
        catch {
            return 0;
        }
    }
    async executeProposal(proposal) {
        await this.ready;
        if (!this.agent || !this.dotCtx)
            return;
        if (this.agent.status !== 'idle')
            return;
        this.executingId = proposal.id;
        try {
            this.executionStartSeq = this.agent.session.snapshotEvents().length;
        }
        catch {
            this.executionStartSeq = 0;
        }
        this.applyExecutionRestriction(this.dotCtx, this.agent, proposal);
        const missingTools = proposal.executionTools.filter((tool) => !this.executionTools.has(tool));
        if (missingTools.length > 0) {
            await this.finishExecution(`Approved execution tools are not available in this Host: ${missingTools.join(', ')}`, true);
            return;
        }
        await this.store.mutate((state) => {
            proposal.status = 'executing';
            proposal.updatedAt = Date.now();
            state.executingId = proposal.id;
            state.pendingAuto = state.pendingAuto.filter((id) => id !== proposal.id);
        });
        const instruction = [
            '[DSH Dot — approved execution]',
            `Approved action: ${proposal.proposedAction}`,
            `Original finding: ${proposal.description}`,
            `Evidence: ${proposal.evidence || '(none provided)'}`,
            `Approved execution tools: ${proposal.executionTools.join(', ') || '(none)'}`,
            `Target workspace: ${this.cwd()}`,
            `Instruction: ${proposal.executionInstruction || proposal.proposedAction}`,
            'Execute only this action. Do not invent new external actions. Do not send, publish, pay, delete, or change an account unless that exact action was approved.',
            'When finished, report the concrete result, including files changed or the exact reason it could not be completed.',
        ].join('\n');
        try {
            this.agent.followup(noticeMessage(instruction, 'Dot approved execution'));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.finishExecution(message, true);
        }
    }
    async recordProposalTaskEvent(proposal, decision, detail) {
        if (!proposal.taskId)
            return;
        try {
            await this.tasks.recordProposalDecision(proposal.taskId, proposal.id, decision, decision === 'failed' ? 'Proposal execution failed' : `Proposal ${decision}`, detail);
        }
        catch (error) {
            this.log('dsh-dot: could not record proposal task event', error);
        }
    }
    queueTaskNotice(text) {
        this.taskNotices.push(text);
        if (this.agent && this.agent.status !== 'running')
            void this.flushTaskNotices();
    }
    async flushTaskNotices() {
        if (this.taskNoticeBusy || this.taskNotices.length === 0)
            return;
        if (!this.agent || this.agent.status === 'running')
            return;
        const text = this.taskNotices.shift();
        if (!text)
            return;
        this.taskNoticeBusy = true;
        try {
            this.agent.followup(noticeMessage(text, 'Dot task notice'));
        }
        catch (error) {
            this.lastDeliveryError = error instanceof Error ? error.message : String(error);
            this.log('dsh-dot: could not deliver task notice', error);
        }
        finally {
            this.taskNoticeBusy = false;
        }
    }
    handleWorkerEvent(event) {
        if (event.kind !== 'idle' && event.kind !== 'failed' && event.kind !== 'cancelled')
            return;
        this.workerEvents.push(event);
        void this.coordinator.pump();
        if (this.agent && this.agent.status !== 'running')
            void this.flushWorkerEvents();
    }
    async flushWorkerEvents() {
        if (this.workerEventBusy || this.workerEvents.length === 0)
            return;
        if (!this.agent || this.agent.status === 'running')
            return;
        const event = this.workerEvents.shift();
        if (!event)
            return;
        this.workerEventBusy = true;
        try {
            this.agent.followup(noticeMessage(formatWorkerEvent(event), 'Dot worker event'));
        }
        catch (error) {
            this.lastDeliveryError = error instanceof Error ? error.message : String(error);
            this.log('dsh-dot: could not deliver worker event', error);
        }
        finally {
            this.workerEventBusy = false;
        }
    }
    async onIdle(agent) {
        await this.store.ensureLoaded();
        if (this.config.orchestrator && this.executingId) {
            // The executor owns this proposal in a separate Agent; never attribute
            // the supervisor's idle turn to the approved execution.
            await this.flushWorkerEvents();
            await this.flushTaskNotices();
            return;
        }
        if (this.executingId) {
            const text = latestAssistantText(agent, this.executionStartSeq);
            await this.finishExecution(text || 'Execution turn ended without a final assistant summary. Verify the target path.', false);
            this.executionStartSeq = 0;
            void this.flushWorkerEvents();
            void this.flushTaskNotices();
            return;
        }
        if (this.config.orchestrator) {
            await this.flushWorkerEvents();
            await this.flushTaskNotices();
            if (this.store.state.pendingAuto.length > 0)
                this.kickExecution();
            return;
        }
        await this.store.mutate((state) => {
            state.lastResearchCompletedAt = Date.now();
            delete state.lastError;
        });
        if (this.store.state.pendingAuto.length > 0)
            this.kickExecution();
    }
    async finishExecution(result, failed) {
        const id = this.executingId;
        if (!id)
            return;
        const proposal = this.store.state.proposals.find((candidate) => candidate.id === id);
        await this.store.mutate((state) => {
            if (proposal) {
                proposal.status = failed ? 'failed' : 'executed';
                proposal.updatedAt = Date.now();
                proposal.executedAt = Date.now();
                proposal.result = result.slice(0, 4000);
            }
            state.executingId = undefined;
        });
        this.executingId = undefined;
        this.executionStartSeq = 0;
        this.executionTools = new Set();
        this.restoreResearchRestriction();
        if (proposal?.taskId) {
            await this.recordProposalTaskEvent(proposal, failed ? 'failed' : 'executed', result);
            this.queueTaskNotice(`Proposal ${failed ? 'failed' : 'executed'}: ${proposal.title}\n${result.slice(0, 900)}\nReview the task and tell the user the next step.`);
        }
        this.injectNotice(`${failed ? 'Execution failed' : 'Execution completed'}: ${proposal?.title ?? id}\n${result.slice(0, 900)}`, 'Dot execution result');
        // Let the user see the finished card before another approved action starts.
        setTimeout(() => {
            if (!this.disposed)
                this.kickExecution();
        }, 250).unref?.();
    }
    async assignWorker(taskId, brief) {
        return this.coordinator.request(taskId, brief);
    }
    async askWorker(workerId, question) {
        await this.workers.ask(workerId, question);
        return { ok: true };
    }
    async focusTask(taskId) {
        await this.coordinator.focus(taskId);
        const task = this.store.state.tasks.find((candidate) => candidate.id === taskId);
        if (!task)
            throw new Error(`task_not_found: ${taskId}`);
        return task;
    }
    async appendChat(role, text) {
        await this.store.ensureLoaded();
        const clean = text.trim().slice(0, 8_000);
        if (!clean)
            throw new Error('message text is required');
        const message = {
            id: `chat_${randomUUID()}`,
            role,
            text: clean,
            at: Date.now(),
        };
        await this.store.mutate((state) => {
            state.chatMessages.push(message);
            if (state.chatMessages.length > 200)
                state.chatMessages = state.chatMessages.slice(-200);
        });
        return message;
    }
    async sendUserChat(text) {
        await this.ready;
        if (!this.agent)
            throw new Error('Dot Agent is not ready');
        const message = await this.appendChat('user', text);
        const prompt = [
            '[Dot user message]',
            message.text,
            'Respond to the user in the Dot chat using dot_say. First acknowledge briefly and say what you will do; then delegate. Do not wait until the work is finished to acknowledge.',
        ].join('\n');
        const notice = noticeMessage(prompt, 'Dot user message');
        if (this.agent.status === 'running')
            this.agent.inject(notice);
        else
            this.agent.followup(notice);
        const seq = ++this.chatRecoverySeq;
        setTimeout(() => void this.recoverChatIfSilent(seq, message.at), 3_000).unref?.();
        return { ok: true, message };
    }
    async recoverChatIfSilent(seq, at) {
        if (seq !== this.chatRecoverySeq || !this.agent)
            return;
        if (this.agent.status === 'running')
            return;
        const answered = this.store.state.chatMessages.some((message) => message.role === 'assistant' && message.at > at);
        if (answered)
            return;
        this.log('dsh-dot: chat Agent did not wake; starting a fresh internal manager');
        const old = this.handle;
        this.handle = undefined;
        this.agent = undefined;
        this.dotCtx = undefined;
        try {
            await old?.dispose();
        }
        catch (error) {
            this.log('dsh-dot: could not dispose stale chat Agent', error);
        }
        try {
            await this.create();
            const history = this.store.state.chatMessages
                .slice(-10)
                .map((message) => `${message.role === 'user' ? 'User' : 'Dot'}: ${message.text}`)
                .join('\n');
            this.agent?.followup(noticeMessage(`[Dot custom chat]\n${history}\n\nRespond to the latest user message using dot_say. First acknowledge briefly and say what you will do.`, 'Dot custom chat recovery'));
        }
        catch (error) {
            this.lastError = error instanceof Error ? error.message : String(error);
            this.log('dsh-dot: could not start a fresh chat manager', error);
        }
    }
    async listWorkspaces() {
        await this.store.ensureLoaded();
        const registry = this.ctx.get?.('workspaceRegistry');
        const list = registry?.list?.() ?? [];
        const current = path.resolve(this.cwd());
        return list.map((workspace) => ({
            id: String(workspace.id),
            title: String(workspace.title ?? workspace.name ?? workspace.path),
            path: String(workspace.path),
            current: path.resolve(String(workspace.path)) === current,
        }));
    }
    async resolveWorkspace(value) {
        if (!value || !value.trim())
            return path.resolve(this.cwd());
        const registry = this.ctx.get?.('workspaceRegistry');
        const byId = registry?.get?.(value);
        const byPath = await registry?.resolveByPath?.(value);
        const candidate = byId?.path ?? byPath?.path ?? (path.isAbsolute(value) ? value : undefined);
        if (!candidate)
            throw new Error(`workspace_not_found: ${value}`);
        const resolved = path.resolve(String(candidate));
        const stat = await fs.stat(resolved);
        if (!stat.isDirectory())
            throw new Error(`workspace_not_a_directory: ${resolved}`);
        return resolved;
    }
    async createTask(input) {
        const workspace = await this.resolveWorkspace(input.workspace);
        return this.tasks.create({ ...input, workspace });
    }
    async addTask(goal, nextStep = '') {
        await this.store.ensureLoaded();
        const task = makeTask(goal, nextStep);
        await this.store.mutate((state) => {
            state.tasks.unshift(task);
            state.tasks = state.tasks.slice(0, 50);
            if (!state.focusedTaskId)
                state.focusedTaskId = task.id;
        });
        return task;
    }
    async updateTask(taskId, patch) {
        await this.store.ensureLoaded();
        const task = this.store.state.tasks.find((candidate) => candidate.id === taskId);
        if (!task)
            return undefined;
        await this.store.mutate(() => {
            const now = Date.now();
            if (typeof patch.progress === 'string' && patch.progress !== task.plan) {
                task.plan = patch.progress;
                appendTaskEvent(task, makeTaskEvent('dot', 'worker_progress', 'Progress updated', patch.progress, now));
            }
            if (typeof patch.nextStep === 'string')
                task.nextAction = patch.nextStep;
            if (patch.status === 'active') {
                if (!['done', 'cancelled', 'running', 'coordinating', 'planned'].includes(task.status)) {
                    transitionTask(task, 'planned', 'Task marked active', { now });
                }
            }
            else if (patch.status === 'done') {
                if (task.status !== 'done' && task.status !== 'cancelled') {
                    task.verifiedResult = patch.progress?.trim() || task.verifiedResult || task.plan || 'Completed by Dot.';
                    transitionTask(task, 'done', 'Task marked done', { now });
                }
            }
            task.updatedAt = Math.max(task.updatedAt, now);
        });
        return task;
    }
    async registerTrigger(input) {
        await this.store.ensureLoaded();
        const trigger = {
            id: `trigger_${randomUUID()}`,
            source: input.source.trim(),
            condition: input.condition.trim(),
            instruction: input.instruction.trim(),
            createdAt: Date.now(),
            enabled: true,
        };
        await this.store.mutate((state) => {
            state.triggers.unshift(trigger);
            state.triggers = state.triggers.slice(0, 50);
        });
        return trigger;
    }
    /** Local event entry point: neither a Tool nor a webhook can execute an action directly. */
    async fireTrigger(triggerId, payload) {
        await this.store.ensureLoaded();
        const trigger = this.store.state.triggers.find((candidate) => candidate.id === triggerId);
        if (!trigger)
            return { fired: false, reason: 'trigger_not_found' };
        if (!trigger.enabled)
            return { fired: false, reason: 'trigger_disabled' };
        if (!this.agent)
            return { fired: false, reason: 'agent_not_ready' };
        const text = safeJson(payload);
        if (!conditionMatches(trigger.condition, text)) {
            return { fired: false, reason: 'condition_not_matched' };
        }
        await this.store.mutate(() => {
            trigger.lastFiredAt = Date.now();
        });
        if (this.config.orchestrator) {
            try {
                const created = await this.tasks.create({
                    title: `Event: ${trigger.source}`,
                    request: trigger.instruction,
                    nextAction: 'Review the trigger payload and assign a worker if needed.',
                    plan: `Trigger ${trigger.condition} fired for ${trigger.source}.`,
                });
                await this.store.mutate((state) => {
                    const task = state.tasks.find((candidate) => candidate.id === created.task.id);
                    if (!task)
                        return;
                    appendTaskEvent(task, makeTaskEvent('system', 'created', 'Event trigger created a task', text.slice(0, 2_000)));
                });
                this.queueTaskNotice(`Trigger fired: ${trigger.source}/${trigger.condition}\nTask: ${created.task.title} (${created.task.id})\nPayload: ${text.slice(0, 900)}\nReview the task and assign a worker if appropriate.`);
                return { fired: true, taskId: created.task.id };
            }
            catch (error) {
                return { fired: false, reason: error instanceof Error ? error.message : String(error) };
            }
        }
        const prompt = [
            'DSH Dot event trigger.',
            `Source: ${trigger.source}`,
            `Condition: ${trigger.condition}`,
            `Payload: ${text.slice(0, 5000)}`,
            `Instruction: ${trigger.instruction}`,
            'Investigate only with read-only tools. If this needs action, propose it with dot_propose_action. Do not execute writes in research mode.',
        ].join('\n');
        try {
            const message = noticeMessage(prompt, 'Dot event trigger');
            if (this.agent.status === 'running')
                this.agent.inject(message);
            else
                this.agent.followup(message);
            return { fired: true };
        }
        catch (error) {
            return { fired: false, reason: error instanceof Error ? error.message : String(error) };
        }
    }
    async scheduleTask(input) {
        await this.ready;
        if (!this.agent)
            throw new Error('Dot Agent is not ready');
        const schedule = this.ctx.get?.('schedule');
        if (!schedule)
            throw new Error('the schedule service is unavailable');
        const prompt = this.config.orchestrator
            ? [
                '[DSH Dot scheduled task]',
                `Create or update one task: ${input.title}`,
                `Instruction: ${input.prompt}`,
                'Use dot_create_task if no matching task exists. Assign a worker only if the task is concrete; do not execute real writes without user approval.',
            ].join('\n')
            : input.prompt;
        if (input.cronExpression) {
            return await schedule.create(String(this.agent.id), {
                title: input.title,
                prompt,
                cron: {
                    expression: input.cronExpression,
                    time_zone: input.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
                },
            });
        }
        if (!input.everySeconds || input.everySeconds < 60) {
            throw new Error('every_seconds must be at least 60');
        }
        return await schedule.create(String(this.agent.id), {
            title: input.title,
            prompt,
            every_seconds: input.everySeconds,
        });
    }
    async listSchedules() {
        await this.ready.catch(() => { });
        const schedule = this.ctx.get?.('schedule');
        if (!schedule || !this.agent)
            return [];
        try {
            const records = (await schedule.list({ sessionId: String(this.agent.id) }));
            return records.map((record) => ({
                id: String(record.id),
                title: String(record.title ?? record.prompt ?? 'Scheduled task'),
                kind: String(record.kind ?? 'schedule'),
                detail: record.kind === 'cron'
                    ? `cron ${String(record.expression)} (${String(record.timeZone)})`
                    : record.kind === 'every'
                        ? `every ${String(record.everySeconds)}s`
                        : String(record.scheduledAt ?? ''),
                scheduledAt: typeof record.scheduledAt === 'string' ? record.scheduledAt : undefined,
            }));
        }
        catch {
            return [];
        }
    }
    async getClientState() {
        await this.ready.catch(() => { });
        const state = this.store.state;
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
        };
    }
    getScopedState() {
        const state = this.store.state;
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
        };
    }
    injectNotice(text, summary) {
        if (!this.agent)
            return;
        try {
            this.agent.inject(noticeMessage(text, summary));
        }
        catch (error) {
            this.log('dsh-dot: could not inject notice', error);
        }
    }
    buildResearchPrompt() {
        const sources = this.config.sources
            .filter((source) => source.enabled !== false)
            .map((source) => {
            if (source.kind === 'directory') {
                return `- ${source.label}: directory at ${source.path}. Use glob and read.`;
            }
            if (source.kind === 'url') {
                return `- ${source.label}: ${source.url}. Use web_fetch.`;
            }
            return `- ${source.label}: MCP tools ${(source.tools ?? []).join(', ') || '(none listed)'}.`;
        })
            .join('\n');
        const outbox = this.outboxPath();
        const activeTasks = this.store.state.tasks.filter((task) => task.status !== 'done' && task.status !== 'cancelled');
        const existingProposals = this.store.state.proposals.slice(0, 8);
        const proposalLines = existingProposals.length > 0
            ? [
                'Existing proposals (do not duplicate these):',
                ...existingProposals.map((proposal) => `- [${proposal.status}] ${proposal.title} (${proposal.actionType})`),
            ]
            : [];
        const taskLines = activeTasks.length > 0
            ? [
                'Active tracked tasks:',
                ...activeTasks.map((task) => `- ${task.title} | status: ${task.status} | plan: ${task.plan} | next: ${task.nextAction} | id: ${task.id}`),
                'If a tracked task has a safe, concrete next step, propose it. Do not invent progress.',
            ]
            : [];
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
            .join('\n');
    }
    outboxPath() {
        const directorySource = this.config.sources.find((source) => source.kind === 'directory' && source.path);
        if (!directorySource?.path)
            return '';
        return path.resolve(directorySource.path, '..', 'outbox');
    }
    cwd() {
        if (this.config.dotWorkspace)
            return path.resolve(this.config.dotWorkspace);
        const workingDirectory = this.ctx.get?.('workingDirectory')?.defaultDirectory;
        return path.resolve(workingDirectory || process.cwd());
    }
    agentOptions() {
        const selection = this.ctx.get?.('agentDefaultModel')?.currentSelection?.();
        if (!selection?.provider || !selection?.model)
            return {};
        return { provider: selection.provider, model: selection.model };
    }
    setTitle() {
        if (!this.agent)
            return;
        try {
            this.ctx.get?.('sessionTitle')?.rename?.(this.agent.session, 'Dot');
        }
        catch (error) {
            this.log('dsh-dot: could not set the Dot Session title', error);
        }
    }
}
function availableTools(ctx, requested, agent) {
    const schemas = agent
        ? ctx.tools.schemas?.(agent) ?? ctx.tools.schemas?.() ?? []
        : ctx.tools.schemas?.() ?? [];
    const available = new Set(schemas.map((schema) => String(schema.name)));
    return new Set(requested.filter((name) => available.has(name)));
}
function normalizeExecutionTools(requested, allowed) {
    const allowedSet = new Set(allowed);
    const tools = [...new Set(requested)];
    for (const tool of tools) {
        if (!allowedSet.has(tool)) {
            throw new Error(`execution tool "${tool}" is not in the configured executionTools`);
        }
    }
    return tools;
}
function validateProposalInput(args) {
    const title = text(args?.title, 'title', 160);
    const description = text(args?.description, 'description', 2000);
    const proposedAction = text(args?.proposed_action, 'proposed_action', 2000);
    const actionType = text(args?.action_type, 'action_type', 80);
    const source = typeof args?.source === 'string' ? args.source.slice(0, 200) : 'research';
    const evidence = typeof args?.evidence === 'string' ? args.evidence.slice(0, 2000) : '';
    const executionTools = Array.isArray(args?.execution_tools)
        ? args.execution_tools.filter((tool) => typeof tool === 'string')
        : [];
    const executionInstruction = typeof args?.execution_instruction === 'string'
        ? args.execution_instruction.slice(0, 2000)
        : '';
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
    };
}
function text(value, field, max) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${field} must be a non-empty string`);
    }
    return value.trim().slice(0, max);
}
function noticeMessage(text, summary) {
    return {
        id: `dot-notice-${randomUUID()}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'dsh-dot', form: 'notice', summary },
    };
}
function formatWorkerEvent(event) {
    const lines = [
        '[Dot worker event]',
        `Task: ${event.taskTitle} (${event.taskId})`,
        `Worker: ${event.workerId}`,
        `Kind: ${event.kind}`,
    ];
    if (event.result)
        lines.push(`Result: ${event.result.slice(0, 4000)}`);
    if (event.error)
        lines.push(`Error: ${event.error.slice(0, 1000)}`);
    lines.push(event.kind === 'idle'
        ? 'Review the result, update the task, and tell the user the next step. Do not claim completion without evidence.'
        : 'Report the blocker to the user and keep other tasks moving.');
    return lines.join('\n');
}
function latestAssistantText(agent, startIndex = 0) {
    try {
        const events = agent.session?.snapshotEvents?.() ?? [];
        for (let index = events.length - 1; index >= startIndex; index -= 1) {
            const event = events[index];
            if (event?.type !== 'assistant/message')
                continue;
            const blocks = event.data?.message?.content ?? [];
            const text = blocks
                .filter((block) => block?.type === 'text' && typeof block.text === 'string')
                .map((block) => block.text)
                .join('\n')
                .trim();
            if (text)
                return text;
        }
    }
    catch {
        // Disposed sessions may no longer be readable.
    }
    return '';
}
function safeJson(value) {
    try {
        return JSON.stringify(value ?? null);
    }
    catch {
        return String(value);
    }
}
function conditionMatches(condition, text) {
    const trimmed = condition.trim();
    if (!trimmed || trimmed === '*')
        return true;
    try {
        return new RegExp(trimmed, 'i').test(text);
    }
    catch {
        return text.toLowerCase().includes(trimmed.toLowerCase());
    }
}
function proposalFingerprint(input) {
    const text = [input.taskId ?? '', input.actionType, input.title, input.proposedAction, input.executionInstruction]
        .join('\n')
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
        .trim();
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
}
