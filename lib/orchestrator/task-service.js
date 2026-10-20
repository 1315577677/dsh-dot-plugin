import { randomUUID } from 'node:crypto';
import { appendTaskEvent, isTaskPriority, isTaskStatus, makeTask, makeTaskEvent, transitionTask, } from '../tasks.js';
const DEDUPE_WINDOW_MS = 5 * 60_000;
/**
 * Durable task operations for the supervisor. It has no Agent or worker
 * behavior; the model-facing tools are thin wrappers over this service.
 */
export class TaskService {
    store;
    log;
    constructor(store, log = () => { }) {
        this.store = store;
        this.log = log;
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
            now - task.createdAt <= DEDUPE_WINDOW_MS);
        if (recent)
            return { task: recent, deduped: true };
        const priority = isTaskPriority(input.priority) ? input.priority : 'normal';
        const task = makeTask(title, input.nextAction ?? '', priority, now);
        task.request = request;
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
        await this.store.mutate((state) => {
            const now = Date.now();
            if (typeof patch.plan === 'string' && patch.plan !== task.plan) {
                task.plan = patch.plan;
                appendTaskEvent(task, makeTaskEvent('dot', 'worker_progress', 'Plan updated', patch.plan, now));
            }
            if (typeof patch.nextAction === 'string')
                task.nextAction = patch.nextAction;
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
            }
            task.updatedAt = Math.max(task.updatedAt, now);
            validateFocus(state);
        });
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
        await this.store.mutate(() => {
            if (verifiedResult?.trim())
                task.verifiedResult = verifiedResult;
            if (!task.verifiedResult?.trim() && task.artifacts.length === 0) {
                throw new Error('task cannot be completed without an artifact or verified_result');
            }
            if (task.status !== 'done') {
                transitionTask(task, 'done', 'Task completed', { actor: 'dot', now: Date.now() });
            }
        });
        return task;
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
            .map((task) => ({ ...task, focused: task.id === focusedId }));
    }
    async detail(taskId) {
        await this.store.ensureLoaded();
        const task = this.find(taskId);
        return {
            task,
            proposals: this.store.state.proposals.filter((proposal) => proposal.taskId === task.id),
            focused: this.store.state.focusedTaskId === task.id,
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
