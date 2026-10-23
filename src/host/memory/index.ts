import path from 'node:path'
import type { MemoryStore } from './store.js'
import { dayKey, splitFrontMatter, truncate } from './store.js'

type Log = (message: string, ...args: unknown[]) => void

/**
 * Dependency-free inverted index over the memory Markdown files.
 *
 * No embeddings: tokens come from the file name, the front-matter, headings and
 * the start of each line. Retrieval is deterministic, so a hit can always be
 * shown to the user as "path + date + snippet".
 */

export interface RecallHit {
  path: string
  date: string
  line: number
  snippet: string
  score: number
  why: string
}

export interface TimeRange {
  from: string
  to: string
  label: string
  granularity: 'day' | 'week' | 'month' | 'year'
}

export interface RecallOptions {
  query: string
  when?: string
  scope?: string
  limit?: number
  now?: number
}

export interface RecallResult {
  hits: RecallHit[]
  parsed: {
    keywords: string[]
    time: TimeRange | null
    scope: string
  }
  /** 0 = exact window, 1 = widened to the year(s), 2 = no time filter, 3 = no hits */
  relaxed: number
}

interface Doc {
  path: string
  date: string
  scope: string
  lines: string[]
  hits: number
}

interface Entry {
  doc: number
  line: number
  weight: number
}

const TITLE_WEIGHT = 3
const BULLET_WEIGHT = 1.5
const BODY_WEIGHT = 1
const MIN_SCORE = 1.5
const MAX_ENTRIES_PER_TOKEN = 400
const MAX_LINES_PER_DOC = 220
const MAX_INDEXED_LINE_CHARS = 160
const REMOVED_PATH = '\u0000removed'

const CN_NUMBER: Record<string, string> = {
  一: '1',
  二: '2',
  三: '3',
  四: '4',
  五: '5',
  六: '6',
  七: '7',
  八: '8',
  九: '9',
  十: '10',
  十一: '11',
  十二: '12',
}

const STOPWORDS = new Set([
  '那个',
  '那件',
  '那件事',
  '事情',
  '上次',
  '之前',
  '以前',
  '后来',
  '然后',
  '关于',
  '我们',
  '我的',
  '帮我',
  '什么',
  '怎么',
  '一个',
  '这个',
  '现在',
  '记得',
  '是不是',
  '有没有',
  '你还',
  '我说',
  '说过',
  '提过',
  '让你',
  '给我',
  '的',
  '了',
  '吗',
  '呢',
  '吧',
  'the',
  'and',
  'that',
  'this',
  'what',
  'did',
  'you',
])

function emptySlot(): Doc {
  return { path: REMOVED_PATH, date: '', scope: '', lines: [], hits: 0 }
}

function isCjk(char: string): boolean {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(char)
}

/**
 * Chinese is indexed as character bigrams, Latin/digits as whole words. Crude,
 * but deterministic and good enough for "邮件自动化" style lookups.
 */
export function tokenize(text: string): string[] {
  const source = String(text ?? '').toLowerCase()
  const tokens: string[] = []
  let cjk = ''
  let word = ''

  const flushCjk = (): void => {
    if (!cjk) return
    if (cjk.length === 1) {
      if (!STOPWORDS.has(cjk)) tokens.push(cjk)
    } else {
      for (let index = 0; index + 1 < cjk.length; index += 1) {
        const bigram = cjk.slice(index, index + 2)
        if (!STOPWORDS.has(bigram)) tokens.push(bigram)
      }
    }
    cjk = ''
  }

  const flushWord = (): void => {
    if (word.length >= 2 && !STOPWORDS.has(word)) tokens.push(word)
    word = ''
  }

  for (const char of source) {
    if (isCjk(char)) {
      flushWord()
      cjk += char
      continue
    }
    flushCjk()
    if (/[a-z0-9_-]/.test(char)) {
      word += char
      continue
    }
    flushWord()
  }
  flushCjk()
  flushWord()
  return [...new Set(tokens)]
}

function ymd(date: Date): string {
  return dayKey(date)
}

function startOfDay(at: number): Date {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date
}

function addDays(at: number, days: number): Date {
  const date = new Date(at)
  date.setDate(date.getDate() + days)
  return date
}

function monthBounds(year: number, month: number): TimeRange {
  const from = new Date(year, month - 1, 1)
  const to = new Date(year, month, 0)
  return {
    from: ymd(from),
    to: ymd(to),
    label: `${year}-${String(month).padStart(2, '0')}`,
    granularity: 'month',
  }
}

/** "十二月" -> "12月", "十月" -> "10月" so the numeric branches can handle it. */
function normalizeMonthNumerals(text: string): string {
  return text.replace(/(十二|十一|十|[一二三四五六七八九])/g, (match) => CN_NUMBER[match] ?? match)
}

/**
 * Parse a fuzzy Chinese/English time reference. Returns null when the text
 * contains no usable date, so callers can fall back to keywords only.
 */
export function parseTimeRange(text: string, now = Date.now()): TimeRange | null {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  const normalized = normalizeMonthNumerals(
    raw
      .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
      .replace(/\s+/g, ''),
  )
  const today = startOfDay(now)
  const year = today.getFullYear()
  const month = today.getMonth() + 1

  let match = /(\d{4})-(\d{2})-(\d{2})/.exec(normalized)
  if (match) {
    const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    return { from: ymd(day), to: ymd(day), label: ymd(day), granularity: 'day' }
  }

  match = /(\d{4})年(\d{1,2})月/.exec(normalized) ?? /(\d{4})-(\d{2})(?!\d)/.exec(normalized)
  if (match) return monthBounds(Number(match[1]), Number(match[2]))

  match = /(前年|去年|今年|明年)(\d{1,2})月/.exec(normalized)
  if (match) {
    const offset = match[1] === '去年' ? -1 : match[1] === '前年' ? -2 : match[1] === '明年' ? 1 : 0
    const targetMonth = Math.min(12, Math.max(1, Number(match[2])))
    return monthBounds(year + offset, targetMonth)
  }

  match = /(前年|去年|今年|明年)/.exec(normalized)
  if (match) {
    const offset = match[1] === '去年' ? -1 : match[1] === '前年' ? -2 : match[1] === '明年' ? 1 : 0
    const targetYear = year + offset
    return {
      from: `${targetYear}-01-01`,
      to: `${targetYear}-12-31`,
      label: String(targetYear),
      granularity: 'year',
    }
  }

  if (/上个?月/.test(normalized)) {
    const previous = new Date(year, month - 2, 1)
    return monthBounds(previous.getFullYear(), previous.getMonth() + 1)
  }
  if (/(这个月|本月)/.test(normalized)) return monthBounds(year, month)

  const weekday = today.getDay() === 0 ? 7 : today.getDay()
  if (/(上个?周|上个?星期)/.test(normalized)) {
    const mondayThisWeek = addDays(today.getTime(), -(weekday - 1))
    const mondayLastWeek = addDays(mondayThisWeek.getTime(), -7)
    const sundayLastWeek = addDays(mondayLastWeek.getTime(), 6)
    return {
      from: ymd(mondayLastWeek),
      to: ymd(sundayLastWeek),
      label: `${ymd(mondayLastWeek)}~${ymd(sundayLastWeek)}`,
      granularity: 'week',
    }
  }
  if (/(这周|本周|这星期)/.test(normalized)) {
    const mondayThisWeek = addDays(today.getTime(), -(weekday - 1))
    const sundayThisWeek = addDays(mondayThisWeek.getTime(), 6)
    return {
      from: ymd(mondayThisWeek),
      to: ymd(sundayThisWeek),
      label: `${ymd(mondayThisWeek)}~${ymd(sundayThisWeek)}`,
      granularity: 'week',
    }
  }

  match = /(前天|昨天|今天|今日)/.exec(normalized)
  if (match) {
    const offset = match[1] === '前天' ? -2 : match[1] === '昨天' ? -1 : 0
    const day = addDays(today.getTime(), offset)
    return { from: ymd(day), to: ymd(day), label: ymd(day), granularity: 'day' }
  }

  // A bare "十月" is ambiguous: assume the current year and label it that way.
  match = /(\d{1,2})月/.exec(normalized)
  if (match) return monthBounds(year, Math.min(12, Math.max(1, Number(match[1]))))

  return null
}

function widen(range: TimeRange, level: number): TimeRange | null {
  if (level <= 0) return range
  if (level === 1) {
    return {
      from: `${range.from.slice(0, 4)}-01-01`,
      to: `${range.to.slice(0, 4)}-12-31`,
      label: `${range.from.slice(0, 4)}~${range.to.slice(0, 4)}`,
      granularity: 'year',
    }
  }
  return null
}

export class MemoryIndex {
  private docs: Doc[] = []
  private entries = new Map<string, Entry[]>()
  private built = false
  private building?: Promise<void>

  constructor(private readonly store: MemoryStore, private readonly log: Log = () => {}) {}

  get size(): number {
    return this.docs.filter((doc) => doc.path !== REMOVED_PATH).length
  }

  async refresh(): Promise<void> {
    this.building ??= this.build()
    await this.building
    this.building = undefined
  }

  private async build(): Promise<void> {
    this.docs = []
    this.entries.clear()
    let docs: string[] = []
    try {
      docs = await this.store.listDocs()
    } catch (error) {
      this.log('dsh-dot memory: index build could not list docs', error)
      this.built = true
      return
    }
    for (const relative of docs) {
      try {
        const text = await this.store.readDoc(relative)
        if (!text) continue
        this.addDoc(relative, text)
      } catch (error) {
        this.log(`dsh-dot memory: index skipped ${relative}`, error)
      }
    }
    this.built = true
  }

  /** Add or replace one document. Safe for a doc that is already indexed. */
  async upsertDoc(relative: string, text: string): Promise<void> {
    if (!this.built) await this.refresh()
    this.removeDoc(relative)
    this.addDoc(relative, text)
  }

  /**
   * Doc indices stay stable: a removed doc becomes a reusable slot instead of
   * shifting the array, because every index entry stores the doc index.
   */
  private removeDoc(relative: string): void {
    const existing = this.docs.findIndex((doc) => doc.path === relative)
    if (existing < 0) return
    for (const [token, list] of this.entries) {
      const kept = list.filter((entry) => entry.doc !== existing)
      if (kept.length === 0) this.entries.delete(token)
      else this.entries.set(token, kept)
    }
    this.docs[existing] = emptySlot()
  }

  private addDoc(relative: string, text: string): void {
    const described = describeDoc(relative, text)
    const doc: Doc = {
      path: relative,
      date: described.date,
      scope: described.scope,
      lines: text.split('\n').slice(0, MAX_LINES_PER_DOC),
      hits: 0,
    }
    let index = this.docs.findIndex((candidate) => candidate.path === REMOVED_PATH)
    if (index < 0) {
      index = this.docs.length
      this.docs.push(doc)
    } else {
      this.docs[index] = doc
    }

    this.addTokens(path.basename(relative).replace(/\.md$/, ''), index, 0, TITLE_WEIGHT)

    let inFrontMatter = false
    let frontMatterClosed = false
    for (let line = 0; line < doc.lines.length; line += 1) {
      const raw = doc.lines[line]
      const trimmed = raw.trim()
      if (!frontMatterClosed && line === 0 && trimmed === '---') {
        inFrontMatter = true
        continue
      }
      if (inFrontMatter && trimmed === '---') {
        inFrontMatter = false
        frontMatterClosed = true
        continue
      }
      if (!trimmed) continue
      const isTitle = inFrontMatter || /^#{1,6}\s/.test(trimmed)
      const weight = isTitle ? TITLE_WEIGHT : trimmed.startsWith('- ') ? BULLET_WEIGHT : BODY_WEIGHT
      this.addTokens(trimmed.slice(0, MAX_INDEXED_LINE_CHARS), index, line, weight)
    }
  }

  private addTokens(text: string, doc: number, line: number, weight: number): void {
    for (const token of tokenize(text)) {
      const list = this.entries.get(token) ?? []
      if (list.length >= MAX_ENTRIES_PER_TOKEN) continue
      list.push({ doc, line, weight })
      this.entries.set(token, list)
    }
  }

  async query(options: RecallOptions): Promise<RecallResult> {
    if (!this.built) await this.refresh()
    const now = options.now ?? Date.now()
    const limit = Math.min(10, Math.max(1, options.limit ?? 5))
    const scope = (options.scope ?? '').trim()
    const keywords = tokenize(options.query).slice(0, 12)
    const time = parseTimeRange(options.when ?? options.query, now)

    const empty: RecallResult = {
      hits: [],
      parsed: { keywords, time, scope },
      relaxed: 3,
    }
    if (keywords.length === 0 && !time) return empty

    const levels = time ? [0, 1, 2] : [0]
    for (const level of levels) {
      const window = time ? widen(time, level) : null
      const scored: Array<{ doc: Doc; docIndex: number; score: number; line: number }> = []

      for (let docIndex = 0; docIndex < this.docs.length; docIndex += 1) {
        const doc = this.docs[docIndex]
        if (doc.path === REMOVED_PATH) continue
        if (scope && doc.scope !== scope) continue
        if (!matchesWindow(doc.date, window)) continue

        let score = 0
        let bestLine = -1
        let bestLineScore = 0
        for (const keyword of keywords) {
          const list = this.entries.get(keyword)
          if (!list) continue
          for (const entry of list) {
            if (entry.doc !== docIndex) continue
            score += entry.weight * entry.weight
            if (entry.weight > bestLineScore) {
              bestLineScore = entry.weight
              bestLine = entry.line
            }
          }
        }
        if (score <= 0) continue
        if (time) score *= 1.2
        score *= recencyBoost(doc.date, now)
        score *= 1 + 0.03 * Math.min(doc.hits, 5)
        scored.push({ doc, docIndex, score, line: bestLine })
      }

      if (scored.length === 0) continue
      scored.sort((a, b) => b.score - a.score)

      const hits: RecallHit[] = []
      for (const candidate of scored) {
        if (candidate.score < MIN_SCORE) continue
        const snippet = pickSnippet(candidate.doc.lines, candidate.line)
        if (!snippet) continue
        this.docs[candidate.docIndex].hits += 1
        hits.push({
          path: candidate.doc.path,
          date: candidate.doc.date,
          line: candidate.line + 1,
          snippet,
          score: Math.round(candidate.score * 100) / 100,
          why: `${keywords.join(' ')}${window ? ` @${window.label}` : ''}`,
        })
        if (hits.length >= limit) break
      }
      if (hits.length > 0) return { hits, parsed: { keywords, time, scope }, relaxed: level }
    }
    return empty
  }

  /** Journal day keys known to the index, newest first. */
  recentDates(limit = 7): string[] {
    const dates = this.docs
      .filter((doc) => doc.path.startsWith('journal/') && doc.date)
      .map((doc) => doc.date)
    dates.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    const unique: string[] = []
    for (const date of dates) {
      if (!unique.includes(date)) unique.push(date)
      if (unique.length >= limit) break
    }
    return unique
  }
}

function describeDoc(relative: string, text: string): { date: string; scope: string } {
  const { meta } = splitFrontMatter(text)
  const journal = /^journal\/(\d{4})\/(\d{2})\/(\d{4}-\d{2}-\d{2})\.md$/.exec(relative)
  if (journal) return { date: journal[3], scope: meta.projects ?? '' }
  if (relative.startsWith('projects/')) {
    const slug = relative.replace(/^projects\//, '').replace(/\.md$/, '')
    return { date: normalizeDay(meta.last_active || meta.date), scope: meta.slug || slug }
  }
  if (relative.startsWith('rollups/')) {
    const match = /^rollups\/(\d{4})-(\d{2})\.md$/.exec(relative)
    return { date: match ? `${match[1]}-${match[2]}-01` : '', scope: '' }
  }
  return { date: normalizeDay(meta.date || meta.generated_at), scope: meta.scope ?? '' }
}

function normalizeDay(value: string | undefined): string {
  if (!value) return ''
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value))
  return match ? match[1] : ''
}

function matchesWindow(date: string, window: TimeRange | null): boolean {
  if (!window) return true
  if (!date) return false
  return date >= window.from && date <= window.to
}

function recencyBoost(date: string, now: number): number {
  if (!date) return 1
  const at = Date.parse(`${date}T00:00:00`)
  if (!Number.isFinite(at)) return 1
  const ageDays = Math.max(0, (now - at) / 86_400_000)
  if (ageDays <= 30) return 1.15
  if (ageDays <= 365) return 1.05
  return 1
}

function pickSnippet(lines: string[], preferred: number): string {
  const candidates: number[] = []
  if (preferred >= 0) candidates.push(preferred)
  for (let index = 0; index < lines.length; index += 1) {
    if (index !== preferred) candidates.push(index)
  }
  for (const index of candidates) {
    const raw = (lines[index] ?? '').replace(/<!--.*?-->/g, '').trim()
    if (!raw) continue
    if (raw === '---') continue
    if (/^(date|created|generated_at|fact_count|open|slug|title|status|last_active|tags|projects|scope):/.test(raw)) {
      continue
    }
    return truncate(raw, 200)
  }
  return ''
}
