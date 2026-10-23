/** Normalize a raw dependsOn value into a deduped list of task ids. */
export function normalizeDependsOn(value) {
    if (!Array.isArray(value))
        return [];
    const seen = new Set();
    const result = [];
    for (const item of value) {
        if (typeof item !== 'string')
            continue;
        const id = item.trim();
        if (!id || seen.has(id))
            continue;
        seen.add(id);
        result.push(id);
    }
    return result;
}
function depsOf(task) {
    return normalizeDependsOn(task.dependsOn);
}
function dependencyViewOfIds(dependsOn, tasks) {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const waitingOn = [];
    const failedOn = [];
    for (const id of dependsOn) {
        const dependency = byId.get(id);
        if (!dependency) {
            const ref = { id, title: id, status: 'missing' };
            waitingOn.push(ref);
            failedOn.push(ref);
            continue;
        }
        if (dependency.status === 'done')
            continue;
        const ref = { id, title: dependency.title, status: dependency.status };
        waitingOn.push(ref);
        if (dependency.status === 'failed' || dependency.status === 'cancelled')
            failedOn.push(ref);
    }
    return { dependsOn, waitingOn, failedOn };
}
/** Read-only dependency view used by the scheduler and by task listings. */
export function dependencyView(task, tasks) {
    return dependencyViewOfIds(depsOf(task), tasks);
}
/** True only when every declared dependency exists and is `done`. */
export function dependenciesSatisfied(task, tasks) {
    return dependencyView(task, tasks).waitingOn.length === 0;
}
/** Human-readable reason stored in blockedReason when a dependency cannot release. */
export function dependencyBlockedReason(view) {
    if (view.failedOn.length === 0)
        return undefined;
    const parts = view.failedOn.map((dependency) => dependency.status === 'missing'
        ? `"${dependency.id}" is missing`
        : `"${dependency.title}" (${dependency.id}) ${dependency.status}`);
    return `dependency_blocked: waiting for ${parts.join(', ')}`;
}
function reaches(from, target, depsById) {
    const seen = new Set();
    const stack = [from];
    while (stack.length > 0) {
        const id = stack.pop();
        if (id === target)
            return true;
        if (seen.has(id))
            continue;
        seen.add(id);
        for (const next of depsById.get(id) ?? [])
            stack.push(next);
    }
    return false;
}
/**
 * Validate the dependency graph. Throws a stable error code:
 * - dependency_self: a task depends on itself
 * - dependency_missing: a dependency id does not exist
 * - dependency_cycle: path of ids, joined with " -> ", where each step depends on the next
 *
 * `override` supplies the dependency list a task is about to get, so an update
 * can be validated before it is written.
 */
export function validateTaskDependencies(tasks, override) {
    const ids = new Set(tasks.map((task) => task.id));
    const dependsOnById = new Map();
    for (const task of tasks) {
        dependsOnById.set(task.id, depsOf(task));
    }
    if (override) {
        if (!ids.has(override.taskId))
            ids.add(override.taskId);
        dependsOnById.set(override.taskId, normalizeDependsOn(override.dependsOn));
    }
    for (const [taskId, dependsOn] of dependsOnById) {
        for (const dependencyId of dependsOn) {
            if (dependencyId === taskId) {
                throw new Error(`dependency_self: task ${taskId} cannot depend on itself`);
            }
            if (!ids.has(dependencyId)) {
                throw new Error(`dependency_missing: task ${taskId} depends on ${dependencyId}, which does not exist`);
            }
        }
    }
    // DFS path reporting: stack holds the current dependency chain.
    const color = new Map();
    const stack = [];
    const visit = (taskId) => {
        const state = color.get(taskId);
        if (state === 'done')
            return undefined;
        if (state === 'visiting') {
            const start = stack.lastIndexOf(taskId);
            return [...stack.slice(start === -1 ? 0 : start), taskId];
        }
        color.set(taskId, 'visiting');
        stack.push(taskId);
        for (const dependencyId of dependsOnById.get(taskId) ?? []) {
            const cycle = visit(dependencyId);
            if (cycle)
                return cycle;
        }
        stack.pop();
        color.set(taskId, 'done');
        return undefined;
    };
    for (const taskId of dependsOnById.keys()) {
        const cycle = visit(taskId);
        if (cycle) {
            throw new Error(`dependency_cycle: ${cycle.join(' -> ')}`);
        }
    }
}
/**
 * Drop edges that can never be valid after loading/trimming: self references,
 * ids removed by the task cap, and edges that would close a cycle. Loaded state
 * must be repaired instead of rejected, otherwise one corrupt edge would wipe
 * the whole store.
 */
export function sanitizeDependencies(tasks) {
    const ids = new Set(tasks.map((task) => task.id));
    for (const task of tasks) {
        const kept = [];
        for (const dependencyId of depsOf(task)) {
            if (dependencyId === task.id)
                continue;
            if (!ids.has(dependencyId))
                continue;
            kept.push(dependencyId);
        }
        task.dependsOn = kept;
    }
    // Edges are now known targets; break cycles deterministically in task order.
    const dependsOnById = new Map(tasks.map((task) => [task.id, depsOf(task)]));
    for (const task of tasks) {
        const kept = [];
        for (const dependencyId of dependsOnById.get(task.id) ?? []) {
            if (reaches(dependencyId, task.id, dependsOnById))
                continue;
            kept.push(dependencyId);
        }
        task.dependsOn = kept;
        dependsOnById.set(task.id, kept);
    }
}
