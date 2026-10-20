/**
 * The only place that decides which task gets a worker slot. Focus is a
 * priority, not ownership: it never cancels another task.
 */
export class Coordinator {
    store;
    tasks;
    workers;
    maxWorkers;
    log;
    requests = new Map();
    pumping;
    repump = false;
    constructor(options) {
        this.store = options.store;
        this.tasks = options.tasks;
        this.workers = options.workers;
        this.maxWorkers = Math.max(1, options.maxWorkers);
        this.log = options.log ?? (() => { });
    }
    async request(taskId, brief) {
        await this.store.ensureLoaded();
        const task = this.findTask(taskId);
        if (!['planned', 'blocked'].includes(task.status)) {
            throw new Error(`task_not_assignable: ${task.status}`);
        }
        if (this.activeWorkerForTask(taskId))
            throw new Error('task_already_has_active_worker');
        this.requests.set(taskId, brief.trim() || 'Work on the task.');
        await this.pump();
        return {
            taskId,
            queued: this.requests.has(taskId),
            started: Boolean(this.activeWorkerForTask(taskId)),
        };
    }
    async focus(taskId) {
        await this.tasks.focus(taskId);
        await this.pump();
    }
    async pump() {
        if (this.pumping) {
            this.repump = true;
            await this.pumping;
            return;
        }
        const running = this.runPump();
        this.pumping = running;
        try {
            await running;
        }
        finally {
            this.pumping = undefined;
            if (this.repump) {
                this.repump = false;
                await this.pump();
            }
        }
    }
    get queued() {
        return this.requests.size;
    }
    async runPump() {
        while (this.activeCount() < this.maxWorkers) {
            const next = this.selectNext();
            if (!next)
                return;
            this.requests.delete(next.taskId);
            try {
                await this.workers.spawn(next.taskId, next.brief);
            }
            catch (error) {
                this.log('dsh-dot: coordinator could not start worker', error);
            }
        }
    }
    selectNext() {
        const candidates = [];
        for (const [taskId, brief] of this.requests) {
            const task = this.store.state.tasks.find((candidate) => candidate.id === taskId);
            if (!task) {
                this.requests.delete(taskId);
                continue;
            }
            if (!['planned', 'blocked'].includes(task.status)) {
                this.requests.delete(taskId);
                continue;
            }
            if (this.activeWorkerForTask(taskId)) {
                this.requests.delete(taskId);
                continue;
            }
            candidates.push({ task, brief });
        }
        candidates.sort((left, right) => {
            const leftFocus = left.task.id === this.store.state.focusedTaskId ? 1 : 0;
            const rightFocus = right.task.id === this.store.state.focusedTaskId ? 1 : 0;
            if (leftFocus !== rightFocus)
                return rightFocus - leftFocus;
            const priority = priorityRank(right.task.priority) - priorityRank(left.task.priority);
            if (priority !== 0)
                return priority;
            return left.task.createdAt - right.task.createdAt;
        });
        const first = candidates[0];
        return first ? { taskId: first.task.id, brief: first.brief } : undefined;
    }
    activeCount() {
        return this.store.state.workers.filter((worker) => worker.status === 'starting' || worker.status === 'running').length;
    }
    activeWorkerForTask(taskId) {
        return this.store.state.workers.some((worker) => worker.taskId === taskId && (worker.status === 'starting' || worker.status === 'running'));
    }
    findTask(taskId) {
        const task = this.store.state.tasks.find((candidate) => candidate.id === taskId);
        if (!task)
            throw new Error(`task_not_found: ${taskId}`);
        return task;
    }
}
function priorityRank(priority) {
    if (priority === 'high')
        return 3;
    if (priority === 'low')
        return 1;
    return 2;
}
