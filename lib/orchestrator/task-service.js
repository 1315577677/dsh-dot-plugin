import { randomUUID } from 'node:crypto';
import { appendTaskEvent, isTaskPriority, isTaskStatus, makeTask, makeTaskEvent, transitionTask, } from '../tasks.js';
import { dependencyBlockedReason, dependencyView, normalizeDependsOn, validateTaskDependencies, } from './dependencies.js';
const DEDUPE_WINDOW_MS = 5 * 60_000;
/**
 * Durable task operations for the supervisor. It has no Agent or worker
 * behavior; the model-facing tools are thin wrappers over this service.
 */
export class TaskService {
    store;
    log;
    hooks;
    constructor(store, log = () => { }, hooks = {}) {
        this.store = store;
        this.log = log;
        this.hooks = hooks;
    }
    async create(input) {
        await this.store.ensureLoaded();
        const title = String(input.title ?? '').trim();
        if (!title)
            throw new Error('title is required');
        const request = String(input.request ?? title).trim() || title;
        const now = Date.now();
        const recent = this.store.state.tasks.find((task) => task.title === title &&
            task.request === request &&
            task.status !== 'done' &&
            task.status !== 'cancelled' &&
            (task.workspace ?? '') === (input.workspace ?? '') &&
            now - task.createdAt <= DEDUPE_WINDOW_MS);
        if (recent)
            return { task: recent, deduped: true };
        const priority = isTaskPriority(input.priority) ? input.priority : 'normal';
        const dependsOn = normalizeDependsOn(input.dependsOn);
        const task = makeTask(title, input.nextAction ?? '', priority, now);
        task.request = request;
        task.dependsOn = dependsOn;
        if (dependsOn.length > 0) {
            validateTaskDependencies(this.store.state.tasks, { taskId: task.id, dependsOn });
            appendTaskEvent(task, makeTaskEvent('dot', 'created', 'Dependencies set', dependsOn.join(', '), now));
        }
        if (input.workspace)
            task.workspace = input.workspace;
        if (input.plan)
            task.plan = input.plan;
        if (input.dedupeKey) {
            appendTaskEvent(task, makeTaskEvent('system', 'created', 'Task created with dedupe key', input.dedupeKey, now));
        }
        await this.store.mutate((state) => {
            state.tasks.unshift(task);
            state.tasks = state.tasks.slice(0, 50);
            if (!state.focusedTaskId)
                state.focusedTaskId = task.id;
        });
        return { task, deduped: false };
    }
    async update(taskId, patch) {
        await this.store.ensureLoaded();
        const task = this.find(taskId);
        const previousStatus = task.status;
        const nextDependsOn = patch.dependsOn === undefined ? undefined : normalizeDependsOn(patch.dependsOn);
        if (nextDependsOn) {
            // Validate against the graph the task is about to have, not its old edges.
            validateTaskDependencies(this.store.state.tasks, { taskId: task.id, dependsOn: nextDependsOn });
        }
        let settled = false;
        await this.store.mutate((state) => {
            const now = Date.now();
            if (typeof patch.plan === 'string' && patch.plan !== task.plan) {
                task.plan = patch.plan;
                appendTaskEvent(task, makeTaskEvent('dot', 'worker_progress', 'Plan updated', patch.plan, now));
            }
            if (typeof patch.nextAction === 'string')
                task.nextAction = patch.nextAction;
            const currentDependsOn = Array.isArray(task.dependsOn) ? task.dependsOn : [];
            if (nextDependsOn && nextDependsOn.join('\u0000') !== currentDependsOn.join('\u0000')) {
                const added = nextDependsOn.filter((id) => !currentDependsOn.includes(id));
                const removed = currentDependsOn.filter((id) => !nextDependsOn.includes(id));
                task.dependsOn = nextDependsOn;
                if (task.blockedReason?.startsWith('dependency_'))
                    task.blockedReason = undefined;
                appendTaskEvent(task, makeTaskEvent('dot', 'status_changed', 'Dependencies updated', [
                    ...(added.length > 0 ? [`added: ${added.join(', ')}`] : []),
                    ...(removed.length > 0 ? [`removed: ${removed.join(', ')}`] : []),
                    ...(nextDependsOn.length === 0 ? ['cleared'] : []),
                ].join('; '), now));
            }
            if (isTaskPriority(patch.priority) && task.priority !== patch.priority) {
                task.priority = patch.priority;
                appendTaskEvent(task, makeTaskEvent('dot', 'status_changed', `Priority set to ${patch.priority}`, undefined, now));
            }
            if (typeof patch.verifiedResult === 'string')
                task.verifiedResult = patch.verifiedResult;
            if (isTaskStatus(patch.status) && patch.status !== task.status) {
                if (patch.status === 'blocked' && typeof patch.blockedReason === 'string') {
                    task.blockedReason = patch.blockedReason;
                }
                if (patch.status === 'waiting_user' && typeof patch.waitingFor === 'string') {
                    task.waitingFor = patch.waitingFor;
                }
                if (patch.status === 'blocked' && !task.blockedReason) {
                    task.blockedReason = 'Blocked; the supervisor must supply a reason.';
                }
                if (patch.status === 'waiting_user' && !task.waitingFor) {
                    task.waitingFor = 'Waiting for a user decision.';
                }
                if (patch.status !== 'blocked')
                    task.blockedReason = undefined;
                if (patch.status !== 'waiting_user')
                    task.waitingFor = undefined;
                transitionTask(task, patch.status, `Status changed to ${patch.status}`, { now });
                settled = ['done', 'failed', 'cancelled'].includes(patch.status);
            }
            task.updatedAt = Math.max(task.updatedAt, now);
            validateFocus(state);
        });
        if (settled)
            this.hooks.onTaskSettled?.(task, previousStatus);
        return task;
    }
    async recordProposalCreated(taskId, proposalId, title) {
        await this.store.ensureLoaded();
        const task = this.find(taskId);
        await this.store.mutate(() => {
            if (!task.proposalIds.includes(proposalId))
                task.proposalIds.push(proposalId);
            task.waitingFor = `Decision: ${title}`;
            appendTaskEvent(task, makeTaskEvent('dot', 'decision_requested', 'User decision requested', title, Date.now()));
            if (task.status !== 'waiting_user') {
                if (['planned', 'running', 'coordinating'].includes(task.status)) {
                    transitionTask(task, 'waiting_user', 'Waiting for the user', { now: Date.now(), proposalId });
                }
            }
        });
        return task;
    }
    async recordProposalDecision(taskId, proposalId, decision, summary, detail) {
        await this.store.ensureLoaded();
        const task = this.find(taskId);
        await this.store.mutate(() => {
            task.waitingFor = undefined;
            const now = Date.now();
            if (decision === 'approved') {
                if (task.status !== 'running')
                    transitionTask(task, 'running', summary, { now, proposalId, detail });
                appendTaskEvent(task, makeTaskEvent('user', 'approved', summary, detail, now));
            }
            else if (decision === 'rejected') {
                if (task.status !== 'coordinating')
                    transitionTask(task, 'coordinating', summary, { now, proposalId, detail });
                appendTaskEvent(task, makeTaskEvent('user', 'rejected', summary, detail, now));
            }
            else if (decision === 'executed') {
                if (task.status !== 'coordinating')
                    transitionTask(task, 'coordinating', summary, { now, proposalId, detail });
                appendTaskEvent(task, makeTaskEvent('system', 'executed', summary, detail, now));
            }
            else {
                task.blockedReason = detail?.slice(0, 2_000) || summary;
                if (['running', 'coordinating', 'waiting_user'].includes(task.status)) {
                    transitionTask(task, 'blocked', summary, { now, proposalId, detail });
                }
                appendTaskEvent(task, makeTaskEvent('system', 'blocked', summary, detail, now));
            }
        });
        return task;
    }
    async focus(taskId) {
        await this.store.ensureLoaded();
        const task = this.find(taskId);
        await this.store.mutate((state) => {
            state.focusedTaskId = task.id;
            appendTaskEvent(task, makeTaskEvent('user', 'focus_changed', 'User focused this task', undefined, Date.now()));
        });
        return task;
    }
    async attachArtifact(taskId, input) {
        await this.store.ensureLoaded();
        const task = this.find(taskId);
        const title = String(input.title ?? '').trim();
        if (!title)
            throw new Error('artifact title is required');
        const artifact = {
            id: `artifact_${randomUUID()}`,
            title,
            ...(input.path ? { path: input.path } : {}),
            ...(input.url ? { url: input.url } : {}),
            kind: input.kind ?? 'file',
            createdAt: Date.now(),
        };
        await this.store.mutate(() => {
            task.artifacts.push(artifact);
            appendTaskEvent(task, makeTaskEvent('dot', 'artifact_attached', `Artifact attached: ${title}`, input.path ?? input.url, Date.now()));
        });
        return task;
    }
    async complete(taskId, verifiedResult) {
        await this.store.ensureLoaded();
        const task = this.find(taskId);
        const previousStatus = task.status;
        let changed = false;
        await this.store.mutate(() => {
            if (verifiedResult?.trim())
                task.verifiedResult = verifiedResult;
            if (!task.verifiedResult?.trim() && task.artifacts.length === 0) {
                throw new Error('task cannot be completed without an artifact or verified_result');
            }
            if (task.status !== 'done') {
                transitionTask(task, 'done', 'Task completed', { actor: 'dot', now: Date.now() });
                changed = true;
            }
        });
        if (changed)
            this.hooks.onTaskSettled?.(task, previousStatus);
        return task;
    }
    /**
     * Re-check every dependency edge and block tasks whose prerequisites failed,
     * were cancelled, or disappeared. A blocked dependent is never auto-failed:
     * the user decides whether to retry, re-plan, or cancel it.
     *
     * Returns the tasks that were newly blocked by this pass. Idempotent, so the
     * coordinator can call it at the start of every pump.
     */
    async reconcileDependencies() {
        await this.store.ensureLoaded();
        const state = this.store.state;
        const candidates = state.tasks.filter((task) => Array.isArray(task.dependsOn) &&
            task.dependsOn.length > 0 &&
            !['done', 'failed', 'cancelled'].includes(task.status));
        if (candidates.length === 0)
            return [];
        let needsWork = false;
        for (const task of candidates) {
            const view = dependencyView(task, state.tasks);
            if (view.failedOn.length > 0) {
                const detail = view.failedOn
                    .map((dependency) => `${dependency.id}:${dependency.status}`)
                    .join(', ');
                const summary = `Dependency unavailable: ${view.failedOn
                    .map((dependency) => `"${dependency.title}"`)
                    .join(', ')}`;
                const recorded = task.events.some((event) => event.summary === summary && event.detail === detail);
                if (!recorded || task.blockedReason !== dependencyBlockedReason(view)) {
                    needsWork = true;
                    break;
                }
                continue;
            }
            // A stale failure reason must be cleared once the prerequisite recovers
            // (even if it is not done yet).
            if (task.blockedReason?.startsWith('dependency_')) {
                needsWork = true;
                break;
            }
        }
        if (!needsWork)
            return [];
        const changes = [];
        await this.store.mutate((current) => {
            const now = Date.now();
            for (const task of current.tasks) {
                if (!Array.isArray(task.dependsOn) || task.dependsOn.length === 0)
                    continue;
                if (['done', 'failed', 'cancelled'].includes(task.status))
                    continue;
                const view = dependencyView(task, current.tasks);
                if (view.failedOn.length > 0) {
                    const detail = view.failedOn
                        .map((dependency) => `${dependency.id}:${dependency.status}`)
                        .join(', ');
                    const summary = `Dependency unavailable: ${view.failedOn
                        .map((dependency) => `"${dependency.title}"`)
                        .join(', ')}`;
                    task.blockedReason = dependencyBlockedReason(view);
                    const recorded = task.events.some((event) => event.summary === summary && event.detail === detail);
                    if (!recorded) {
                        if (task.status === 'blocked') {
                            appendTaskEvent(task, makeTaskEvent('system', 'blocked', summary, detail, now));
                        }
                        else {
                            transitionTask(task, 'blocked', summary, { actor: 'system', detail, now });
                        }
                        changes.push({ task, failedOn: view.failedOn });
                    }
                }
                else if (task.blockedReason?.startsWith('dependency_')) {
                    // The prerequisite recovered. Re-plan the dependent; the coordinator
                    // starts it on this same pump if a slot is free.
                    task.blockedReason = undefined;
                    if (task.status === 'blocked') {
                        transitionTask(task, 'planned', 'Dependencies satisfied', { actor: 'system', now });
                    }
                }
            }
        });
        for (const change of changes) {
            this.hooks.onDependencyBlocked?.(change.task, change.failedOn);
        }
        return changes;
    }
    /** Read-only dependency state for one task. */
    dependenciesOf(taskId) {
        const task = this.find(taskId);
        const view = dependencyView(task, this.store.state.tasks);
        return {
            dependsOn: view.dependsOn,
            waitingOn: view.waitingOn.map((dependency) => dependency.id),
            waitingOnTitles: view.waitingOn.map((dependency) => dependency.title),
        };
    }
    async list() {
        await this.store.ensureLoaded();
        const focusedId = this.store.state.focusedTaskId;
        return this.store.state.tasks
            .slice()
            .sort((left, right) => {
            if (left.id === focusedId)
                return -1;
            if (right.id === focusedId)
                return 1;
            return right.updatedAt - left.updatedAt;
        })
            .map((task) => {
            const view = dependencyView(task, this.store.state.tasks);
            return {
                ...task,
                focused: task.id === focusedId,
                waitingOn: view.waitingOn.map((dependency) => dependency.id),
                waitingOnTitles: view.waitingOn.map((dependency) => dependency.title),
            };
        });
    }
    async detail(taskId) {
        await this.store.ensureLoaded();
        const task = this.find(taskId);
        const view = dependencyView(task, this.store.state.tasks);
        return {
            task,
            proposals: this.store.state.proposals.filter((proposal) => proposal.taskId === task.id),
            focused: this.store.state.focusedTaskId === task.id,
            waitingOn: view.waitingOn.map((dependency) => dependency.id),
            waitingOnTitles: view.waitingOn.map((dependency) => dependency.title),
        };
    }
    find(taskId) {
        const task = this.store.state.tasks.find((candidate) => candidate.id === taskId);
        if (!task)
            throw new Error(`task_not_found: ${taskId}`);
        return task;
    }
}
function validateFocus(state) {
    if (state.focusedTaskId && !state.tasks.some((task) => task.id === state.focusedTaskId)) {
        state.focusedTaskId = undefined;
    }
}
