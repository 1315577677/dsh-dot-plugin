/**
 * Task dependency helpers (DAG edges: task.dependsOn -> prerequisite ids).
 *
 * A dependency is satisfied only by `done`. `failed` and `cancelled` never
 * release a dependent task: it stays blocked until the user decides what to do.
 *
 * This module is pure: it only reads tasks and never touches the store, so the
 * scheduler, the task service, and state normalization share one definition.
 */
import type { DotTaskV2, TaskStatus } from '../types.js'

export type DependencyStatus = TaskStatus | 'missing'

export interface DependencyRef {
  id: string
  title: string
  status: DependencyStatus
}

export interface DependencyView {
  /** Declared dependency ids, normalized (deduped, no empty entries). */
  dependsOn: string[]
  /** Dependencies that are not done yet, including missing or failed ones. */
  waitingOn: DependencyRef[]
  /** Dependencies that can never satisfy the edge without user action. */
  failedOn: DependencyRef[]
}

export interface DependencyChange {
  task: DotTaskV2
  failedOn: DependencyRef[]
}

/** Normalize a raw dependsOn value into a deduped list of task ids. */
export function normalizeDependsOn(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result
}

function depsOf(task: DotTaskV2): string[] {
  return normalizeDependsOn(task.dependsOn)
}

function dependencyViewOfIds(
  dependsOn: string[],
  tasks: readonly DotTaskV2[],
): DependencyView {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const waitingOn: DependencyRef[] = []
  const failedOn: DependencyRef[] = []
  for (const id of dependsOn) {
    const dependency = byId.get(id)
    if (!dependency) {
      const ref: DependencyRef = { id, title: id, status: 'missing' }
      waitingOn.push(ref)
      failedOn.push(ref)
      continue
    }
    if (dependency.status === 'done') continue
    const ref: DependencyRef = { id, title: dependency.title, status: dependency.status }
    waitingOn.push(ref)
    if (dependency.status === 'failed' || dependency.status === 'cancelled') failedOn.push(ref)
  }
  return { dependsOn, waitingOn, failedOn }
}

/** Read-only dependency view used by the scheduler and by task listings. */
export function dependencyView(
  task: DotTaskV2,
  tasks: readonly DotTaskV2[],
): DependencyView {
  return dependencyViewOfIds(depsOf(task), tasks)
}

/** True only when every declared dependency exists and is `done`. */
export function dependenciesSatisfied(
  task: DotTaskV2,
  tasks: readonly DotTaskV2[],
): boolean {
  return dependencyView(task, tasks).waitingOn.length === 0
}

/** Human-readable reason stored in blockedReason when a dependency cannot release. */
export function dependencyBlockedReason(view: DependencyView): string | undefined {
  if (view.failedOn.length === 0) return undefined
  const parts = view.failedOn.map((dependency) =>
    dependency.status === 'missing'
      ? `"${dependency.id}" is missing`
      : `"${dependency.title}" (${dependency.id}) ${dependency.status}`,
  )
  return `dependency_blocked: waiting for ${parts.join(', ')}`
}

function reaches(
  from: string,
  target: string,
  depsById: Map<string, string[]>,
): boolean {
  const seen = new Set<string>()
  const stack = [from]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (id === target) return true
    if (seen.has(id)) continue
    seen.add(id)
    for (const next of depsById.get(id) ?? []) stack.push(next)
  }
  return false
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
export function validateTaskDependencies(
  tasks: readonly DotTaskV2[],
  override?: { taskId: string; dependsOn: string[] },
): void {
  const ids = new Set(tasks.map((task) => task.id))
  const dependsOnById = new Map<string, string[]>()
  for (const task of tasks) {
    dependsOnById.set(task.id, depsOf(task))
  }
  if (override) {
    if (!ids.has(override.taskId)) ids.add(override.taskId)
    dependsOnById.set(override.taskId, normalizeDependsOn(override.dependsOn))
  }

  for (const [taskId, dependsOn] of dependsOnById) {
    for (const dependencyId of dependsOn) {
      if (dependencyId === taskId) {
        throw new Error(`dependency_self: task ${taskId} cannot depend on itself`)
      }
      if (!ids.has(dependencyId)) {
        throw new Error(
          `dependency_missing: task ${taskId} depends on ${dependencyId}, which does not exist`,
        )
      }
    }
  }

  // DFS path reporting: stack holds the current dependency chain.
  const color = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  const visit = (taskId: string): string[] | undefined => {
    const state = color.get(taskId)
    if (state === 'done') return undefined
    if (state === 'visiting') {
      const start = stack.lastIndexOf(taskId)
      return [...stack.slice(start === -1 ? 0 : start), taskId]
    }
    color.set(taskId, 'visiting')
    stack.push(taskId)
    for (const dependencyId of dependsOnById.get(taskId) ?? []) {
      const cycle = visit(dependencyId)
      if (cycle) return cycle
    }
    stack.pop()
    color.set(taskId, 'done')
    return undefined
  }

  for (const taskId of dependsOnById.keys()) {
    const cycle = visit(taskId)
    if (cycle) {
      throw new Error(`dependency_cycle: ${cycle.join(' -> ')}`)
    }
  }
}

/**
 * Drop edges that can never be valid after loading/trimming: self references,
 * ids removed by the task cap, and edges that would close a cycle. Loaded state
 * must be repaired instead of rejected, otherwise one corrupt edge would wipe
 * the whole store.
 */
export function sanitizeDependencies(tasks: DotTaskV2[]): void {
  const ids = new Set(tasks.map((task) => task.id))
  for (const task of tasks) {
    const kept: string[] = []
    for (const dependencyId of depsOf(task)) {
      if (dependencyId === task.id) continue
      if (!ids.has(dependencyId)) continue
      kept.push(dependencyId)
    }
    task.dependsOn = kept
  }

  // Edges are now known targets; break cycles deterministically in task order.
  const dependsOnById = new Map(tasks.map((task) => [task.id, depsOf(task)]))
  for (const task of tasks) {
    const kept: string[] = []
    for (const dependencyId of dependsOnById.get(task.id) ?? []) {
      if (reaches(dependencyId, task.id, dependsOnById)) continue
      kept.push(dependencyId)
    }
    task.dependsOn = kept
    dependsOnById.set(task.id, kept)
  }
}
