import type { MemoryIndex } from './index.js'
import { splitFrontMatter, truncate, type MemoryStore, type OpenLoop } from './store.js'

/**
 * Prompt blocks built from memory files.
 *
 * Budgets are character based: Chinese runs about 2.5 chars per token, so a
 * 3800-char digest is roughly the 1.5k-token ceiling from the architecture doc.
 * Every builder is best-effort: a broken memory file must never stop Dot from
 * replying, so the runtime wraps these calls in try/catch as well.
 */

export const STARTUP_DIGEST_BUDGET = 3800
export const WAKE_SNAPSHOT_BUDGET = 600

const PROFILE_BUDGET = 1300
const PROJECTS_BUDGET = 500
const LOOPS_BUDGET = 700
const RECENT_BUDGET = 1000

export interface DigestOptions {
  now?: number
}

interface ProjectSummary {
  slug: string
  title: string
  last: string
  summary: string
}

export async function buildStartupDigest(
  store: MemoryStore,
  index: MemoryIndex,
  options: DigestOptions = {},
): Promise<string> {
  const now = options.now ?? Date.now()
  const parts: string[] = []

  const profile = compactProfile(await safe<string>(() => store.readProfile(), ''), PROFILE_BUDGET)
  if (profile) parts.push(`### 用户画像\n${profile}`)

  const projects = await safe<ProjectSummary[]>(() => store.projectSummaries(5), [])
  if (projects.length > 0) {
    const lines = projects.map(
      (project) =>
        `- ${project.slug}${project.last ? `（最后活跃 ${project.last}）` : ''}：${project.summary || project.title}`,
    )
    parts.push(`### 活跃项目\n${clipToBudget(lines.join('\n'), PROJECTS_BUDGET)}`)
  }

  const loops = (await safe<OpenLoop[]>(() => store.readLoops(), []))
    .filter((loop) => loop.status === 'open')
    .slice(-10)
    .reverse()
  if (loops.length > 0) {
    const lines = loops.map(
      (loop) => `- ${loop.title}｜卡在 ${loop.blocked_by}｜下一步 ${loop.next}｜起 ${loop.since}`,
    )
    parts.push(`### 未完成的尾巴\n${clipToBudget(lines.join('\n'), LOOPS_BUDGET)}`)
  }

  const recent = await buildRecentLines(store, index, now, RECENT_BUDGET)
  if (recent) parts.push(`### 最近几天\n${recent}`)

  if (parts.length === 0) return ''

  const header = [
    '## 长期记忆（跨会话，已持久化）',
    '下面是 Dot 自己的记忆文件摘要，不是本次对话内容。细节用 dot_recall 查；引用记忆必须给出日期与文件路径；没有记录就直说没有。',
    '',
  ].join('\n')

  return clipToBudget(`${header}${parts.join('\n\n')}\n`, STARTUP_DIGEST_BUDGET)
}

export async function buildWakeSnapshot(
  store: MemoryStore,
  options: DigestOptions = {},
): Promise<string> {
  const now = options.now ?? Date.now()
  const parts: string[] = []

  const loops = (await safe<OpenLoop[]>(() => store.readLoops(), []))
    .filter((loop) => loop.status === 'open')
    .slice(-3)
    .reverse()
  if (loops.length > 0) {
    parts.push(`【尾巴】${loops.map((loop) => `${loop.title}→${loop.next}`).join('；')}`)
  }

  const todayKey = formatDay(new Date(now))
  const yesterdayKey = formatDay(new Date(now - 86_400_000))
  const today = await safe<string[]>(() => store.journalHeadlines(todayKey, 2), [])
  const yesterday = await safe<string[]>(() => store.journalHeadlines(yesterdayKey, 3), [])
  const recent = [...yesterday, ...today]
  if (recent.length > 0) {
    parts.push(`【最近】${recent.map((line) => truncate(line, 60)).join('；')}`)
  }

  if (parts.length === 0) return ''
  return clipToBudget(`[记忆快照]\n${parts.join('\n')}`, WAKE_SNAPSHOT_BUDGET)
}

async function buildRecentLines(
  store: MemoryStore,
  index: MemoryIndex,
  now: number,
  budget: number,
): Promise<string> {
  let days = index.recentDates(7)
  if (days.length === 0) days = await safe<string[]>(() => store.recentJournalDays(7), [])
  if (days.length === 0) return ''

  const lines: string[] = []
  for (const day of days) {
    const headlines = await safe<string[]>(() => store.journalHeadlines(day, 3), [])
    if (headlines.length === 0) continue
    lines.push(`- ${day}`)
    for (const headline of headlines) lines.push(`  - ${headline}`)
    if (lines.join('\n').length > budget) break
  }
  if (lines.length === 0) return ''
  const label = days[0] === formatDay(new Date(now)) ? '（含今天）' : ''
  return clipToBudget(`${label}\n${lines.join('\n')}`.trim(), budget)
}

/** Keep the profile readable but small: drop the front-matter and blank noise. */
function compactProfile(raw: string, budget: number): string {
  if (!raw) return ''
  const body = splitFrontMatter(raw).body
  const lines: string[] = []
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('>')) continue
    if (trimmed.startsWith('# ')) continue
    if (!trimmed.startsWith('## ') && !trimmed.startsWith('- ')) continue
    lines.push(trimmed.replace(/^## /, '- '))
    if (lines.join('\n').length > budget) break
  }
  return clipToBudget(lines.join('\n'), budget)
}

export function clipToBudget(text: string, maxChars: number): string {
  if (!text) return ''
  if (text.length <= maxChars) return text
  const cut = text.slice(0, Math.max(0, maxChars - 24))
  const lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('；'))
  const body = lastBreak > maxChars * 0.5 ? cut.slice(0, lastBreak) : cut
  return `${body}\n…（记忆摘要已截断，细节用 dot_recall）`
}

function formatDay(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

async function safe<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run()
  } catch {
    return fallback
  }
}
