/**
 * Worker capacity policy shared by the coordinator, the runtime, and the
 * supervisor tools.
 *
 * The limit itself is persisted by worker-limit.ts; this module only holds the
 * allowed range, the topic heuristic used to decide whether a queued task is a
 * new topic worth asking the user about, and the read-only capacity view.
 */

export const MIN_WORKER_LIMIT = 2
export const MAX_WORKER_LIMIT = 8
export const DEFAULT_WORKER_LIMIT = 4

/** Two titles at or above this overlap are treated as the same line of work. */
export const SAME_TOPIC_THRESHOLD = 0.34

export type WorkerLimitSource = 'config' | 'user'

export interface TaskTopic {
  title: string
  request?: string
}

export interface RunningTaskView {
  taskId: string
  title: string
  status: string
}

export interface CapacityView {
  limit: number
  minLimit: number
  maxLimit: number
  activeWorkers: number
  queuedTasks: number
  runningTasks: RunningTaskView[]
  queuedTaskTitles: string[]
  source?: WorkerLimitSource
}

const LATIN_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'about', 'please', 'task', 'work',
])

const CJK_STOPWORDS = new Set([
  '帮我', '我的', '这个', '那个', '一下', '可以', '然后', '就是', '看看', '需要', '一个', '什么',
  '怎么', '现在', '还是', '并且', '以及', '如果', '因为', '所以', '已经', '没有', '不是', '顺便',
])

export function isWorkerLimit(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= MIN_WORKER_LIMIT &&
    value <= MAX_WORKER_LIMIT
  )
}

export function clampWorkerLimit(value: number, fallback = DEFAULT_WORKER_LIMIT): number {
  if (!Number.isFinite(value)) return fallback
  const whole = Math.trunc(value)
  if (whole < MIN_WORKER_LIMIT) return MIN_WORKER_LIMIT
  if (whole > MAX_WORKER_LIMIT) return MAX_WORKER_LIMIT
  return whole
}

export function topicTokens(input: TaskTopic): Set<string> {
  const text = `${input.title ?? ''} ${input.request ?? ''}`.toLowerCase()
  const tokens = new Set<string>()
  for (const match of text.matchAll(/[a-z0-9][a-z0-9_-]{2,}/g)) {
    if (!LATIN_STOPWORDS.has(match[0])) tokens.add(match[0])
  }
  for (const match of text.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = match[0]
    if (run.length === 1) {
      if (!CJK_STOPWORDS.has(run)) tokens.add(run)
      continue
    }
    for (let index = 0; index < run.length - 1; index += 1) {
      const bigram = run.slice(index, index + 2)
      if (!CJK_STOPWORDS.has(bigram)) tokens.add(bigram)
    }
  }
  return tokens
}

export function topicOverlap(left: TaskTopic, right: TaskTopic): number {
  const a = topicTokens(left)
  const b = topicTokens(right)
  const smaller = Math.min(a.size, b.size)
  if (smaller === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / smaller
}

/** Conservative: only an obvious overlap counts as the same topic. */
export function sameTopic(left: TaskTopic, right: TaskTopic): boolean {
  return topicOverlap(left, right) >= SAME_TOPIC_THRESHOLD
}
