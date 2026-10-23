import { promises as fs } from 'node:fs'
import type { DotState, DotTaskV2, TaskEvent } from '../types.js'
import { clockLabel, dayKey, loopId, looksLikeSecret, truncate, type MemoryStore } from './store.js'

type Log = (message: string, ...args: unknown[]) => void

/**
 * Deterministic "diary" writer.
 *
 * Task events already live in state.json, but state.json is a rolling window
 * (tasks are capped at 50 in state.ts), so old history disappears. This module
 * copies each event into the daily journal exactly once, keyed by event id, and
 * keeps the open-loops list in sync with non-terminal tasks.
 *
 * It never throws: memory failures are logged and reported, never propagated to
 * the reply path.
 */

export interface AutologOptions {
  /** Max new events copied per run. The backfill passes a much larger number. */
  limit?: number
}

export interface AutologResult {
  appended: number
  skipped: number
  loops: number
  failed: number
}

interface AutologMeta {
  seen: string[]
}

const MAX_SEEN = 4000
const DEFAULT_LIMIT = 300
const MAX_DETAIL = 120

const CLOSE_STATUSES = new Set(['done', 'cancelled'])
const OPEN_STATUSES = new Set(['blocked', 'waiting_user'])

export async function autologTasks(
  state: DotState,
  store: MemoryStore,
  log: Log = () => {},
  options: AutologOptions = {},
): Promise<AutologResult> {
  const result: AutologResult = { appended: 0, skipped: 0, loops: 0, failed: 0 }
  try {
    await store.ensureReady()
  } catch (error) {
    log('dsh-dot memory: memory directory is not writable', error)
    return { ...result, failed: 1 }
  }

  const seen = await readSeen(store, log)
  const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT)

  const events: Array<{ task: DotTaskV2; event: TaskEvent }> = []
  for (const task of state.tasks) {
    for (const event of task.events ?? []) {
      if (!event || typeof event.id !== 'string') continue
      events.push({ task, event })
    }
  }
  events.sort((a, b) => a.event.at - b.event.at)

  for (const { task, event } of events) {
    if (seen.has(event.id)) {
      result.skipped += 1
      continue
    }
    if (result.appended >= limit) break
    try {
      const at = Number.isFinite(event.at) ? event.at : Date.now()
      const day = dayKey(at)
      const line = formatEventLine(task, event, at)
      const written = await store.appendJournal(day, line, `e:${event.id}`)
      if (written) result.appended += 1
      else result.skipped += 1
      seen.add(event.id)
    } catch (error) {
      result.failed += 1
      log(`dsh-dot memory: could not journal event ${event.id}`, error)
    }
  }

  for (const task of state.tasks) {
    try {
      if (OPEN_STATUSES.has(task.status)) {
        await store.upsertLoop({
          id: loopId(`task:${task.id}`),
          title: truncate(task.title, 160),
          blocked_by: task.blockedReason || task.waitingFor || '未指定',
          next: truncate(task.nextAction, 160),
          since: dayKey(Number(task.createdAt) || Date.now()),
          taskId: task.id,
          status: 'open',
        })
        result.loops += 1
      } else if (CLOSE_STATUSES.has(task.status)) {
        const closed = await store.closeLoopByTask(
          task.id,
          truncate(task.verifiedResult || `任务已完成（${task.status}）`, 200),
        )
        if (closed) result.loops += 1
      }
    } catch (error) {
      result.failed += 1
      log(`dsh-dot memory: could not sync open loop for task ${task.id}`, error)
    }
  }

  try {
    await writeSeen(store, seen)
  } catch (error) {
    result.failed += 1
    log('dsh-dot memory: could not persist autolog dedupe state', error)
  }

  return result
}

/** One-time copy of the whole existing task history. Same code path, no cap. */
export async function backfillTasks(
  state: DotState,
  store: MemoryStore,
  log: Log = () => {},
): Promise<AutologResult> {
  return autologTasks(state, store, log, { limit: 5000 })
}

function formatEventLine(task: DotTaskV2, event: TaskEvent, at: number): string {
  const head = `${clockLabel(at)} [${truncate(task.title, 60)}] ${truncate(event.summary, 180)}`
  const detail = event.detail ? ` — ${truncate(event.detail, MAX_DETAIL)}` : ''
  const line = `${head}${detail}`
  if (looksLikeSecret(line)) {
    return `${clockLabel(at)} [${truncate(task.title, 60)}] [已过滤：疑似敏感信息] ${event.type}`
  }
  return line
}

async function readSeen(store: MemoryStore, log: Log): Promise<Set<string>> {
  try {
    const raw = await readText(store.autologFile)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as Partial<AutologMeta>
    if (!parsed || !Array.isArray(parsed.seen)) return new Set()
    return new Set(parsed.seen.filter((id): id is string => typeof id === 'string'))
  } catch (error) {
    log('dsh-dot memory: autolog dedupe state unreadable; starting fresh', error)
    return new Set()
  }
}

async function writeSeen(store: MemoryStore, seen: Set<string>): Promise<void> {
  const payload: AutologMeta = { seen: [...seen].slice(-MAX_SEEN) }
  await store.writeAtomic(store.autologFile, `${JSON.stringify(payload)}\n`)
}

async function readText(target: string): Promise<string> {
  try {
    return await fs.readFile(target, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}
