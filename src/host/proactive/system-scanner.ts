import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Reviewer } from '../reviewer.js'
import type { ResolvedConfig } from '../types.js'

type AnyContext = any
type Log = (message: string, ...args: unknown[]) => void

const execFileAsync = promisify(execFile)
const STATE_FILE = 'system-proactive.json'
const SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1_000

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage',
  '.cache', '.turbo', '.venv', 'venv', '__pycache__', 'target', 'vendor',
  'Pods', '.gradle', '.idea', '.vscode', 'tmp', 'temp', 'logs',
])
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java',
  '.kt', '.swift', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php',
  '.md', '.json', '.yml', '.yaml', '.toml', '.sql', '.sh', '.css', '.scss',
  '.vue', '.svelte', '.html',
])
const SECRET_NAMES = /(^|\/)(\.env|\.env\..*|.*\.pem|.*\.key|id_rsa|id_ed25519|secrets?\.(json|ya?ml|toml))$/i

export interface SystemFinding {
  workspace: string
  title: string
  file: string
  kind: string
  severity: 'low' | 'medium' | 'high'
  confidence: number
  evidence: string
  why: string
  key: string
}

interface ProactiveState {
  version: 1
  lastScanAt?: number
  lastNotifiedAt?: number
  day?: string
  count?: number
  seen: Record<string, number>
}

interface RecentFile {
  absolute: string
  relative: string
  mtime: number
  size: number
}

interface WorkspaceActivity {
  path: string
  title: string
  recent: RecentFile[]
  gitStatus: string
  gitDiff: string
  score: number
  focus: string
}

interface WorkspaceEvidence {
  path: string
  title: string
  files: string[]
  snippets: string
  gitStatus: string
  gitDiff: string
  focus: string
}

export interface SystemProactiveScannerOptions {
  ctx: AnyContext
  config: ResolvedConfig
  reviewer: Reviewer
  dataDir: string
  deliver: (finding: SystemFinding) => Promise<boolean>
  log?: Log
}

/**
 * Separate, opt-in proactive scanner owned by the Host, not by Dot.
 *
 * It reads recent workspace activity only. It cannot write, assign workers, or
 * access Dot's schedule tools. A finding is delivered to Dot as an unprompted
 * notice; Dot remains responsible for deciding whether to tell the user.
 */
export class SystemProactiveScanner {
  private readonly config: ResolvedConfig['systemProactive']
  private readonly log: Log
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private running = false
  private state?: ProactiveState

  constructor(private readonly options: SystemProactiveScannerOptions) {
    this.config = options.config.systemProactive
    this.log = options.log ?? (() => {})
  }

  start(): () => void {
    if (!this.config.enabled) return () => {}
    const delay = Math.max(60_000, this.config.initialDelayMinutes * 60_000)
    this.schedule(delay)
    return () => {
      this.stopped = true
      if (this.timer) clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private schedule(delay: number): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      void this.tick().finally(() => {
        if (!this.stopped) this.schedule(this.config.intervalMinutes * 60_000)
      })
    }, Math.max(60_000, delay))
    ;(this.timer as any).unref?.()
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.running) return
    if (!this.config.enabled) return
    this.running = true
    try {
      await this.scanNow('timer')
    } catch (error) {
      this.log('dsh-dot: system proactive scan failed', error)
    } finally {
      this.running = false
    }
  }

  /** Run one read-only scan. Exported so a future status page can trigger it. */
  async scanNow(_reason: string): Promise<void> {
    if (!this.config.enabled) return
    if (this.quietNow()) return
    const state = await this.loadState()
    if (state.lastScanAt && Date.now() - state.lastScanAt < this.config.intervalMinutes * 60_000) return
    if (!this.hasBudget(state)) return

    // Stage 1: cheaply measure attention in every workspace. Do not read file
    // contents here; we only need to know where the user's recent work is.
    const activities: WorkspaceActivity[] = []
    for (const workspace of this.listWorkspaces()) {
      try {
        const activity = await this.observe(workspace)
        if (activity) activities.push(activity)
      } catch (error) {
        this.log(`dsh-dot: system proactive attention check skipped ${workspace.path}`, error)
      }
    }
    state.lastScanAt = Date.now()
    await this.saveState(state)
    const focused = activities
      .filter((activity) => activity.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, this.config.focusWorkspaces)
    if (focused.length === 0) return

    // Stage 2: only the focused workspace(s) are read in depth. A finding has
    // to be about the work the user is currently doing, not an unrelated repo.
    const evidence: WorkspaceEvidence[] = []
    for (const activity of focused) {
      try {
        evidence.push(await this.collect(activity))
      } catch (error) {
        this.log(`dsh-dot: system proactive deep scan skipped ${activity.path}`, error)
      }
    }
    if (evidence.length === 0) return

    const candidates: SystemFinding[] = []
    for (const item of evidence) {
      try {
        const findings = await this.options.reviewer.reviewSystemScan({
          workspace: item.path,
          files: item.files,
          gitStatus: item.gitStatus,
          gitDiff: item.gitDiff,
          focus: item.focus,
          snippets: item.snippets,
          minConfidence: this.config.minConfidence,
        })
        for (const finding of findings) {
          candidates.push({
            workspace: item.path,
            title: item.title,
            file: finding.file,
            kind: finding.kind,
            severity: finding.severity,
            confidence: finding.confidence,
            evidence: finding.evidence,
            why: finding.why,
            key: findingKey(item.path, finding.file, finding.kind, finding.why),
          })
        }
      } catch (error) {
        this.log(`dsh-dot: system proactive review failed for ${item.path}`, error)
      }
    }
    if (candidates.length === 0) return
    candidates.sort((left, right) => right.confidence - left.confidence)
    const selected = candidates.find((finding) => !this.wasSeen(state, finding.key))
    if (!selected) return
    if (!this.hasBudget(await this.loadState())) return
    const delivered = await this.options.deliver(selected).catch((error) => {
      this.log('dsh-dot: system proactive delivery failed', error)
      return false
    })
    if (!delivered) return
    const next = await this.loadState()
    next.seen[selected.key] = Date.now()
    next.lastNotifiedAt = Date.now()
    const day = localDay()
    const count = next.day === day ? next.count ?? 0 : 0
    next.day = day
    next.count = count + 1
    await this.saveState(next)
    this.log(
      `dsh-dot: proactive finding delivered: ${selected.workspace} ${selected.file} (${selected.confidence.toFixed(2)})`,
    )
  }

  private listWorkspaces(): Array<{ path: string; title: string }> {
    const registry = this.options.ctx.get?.('workspaceRegistry')
    const list = Array.isArray(registry?.list?.()) ? registry.list() : []
    const allow = this.config.workspaceAllowlist.map((item) => path.resolve(expandHome(item)))
    const deny = this.config.workspaceDenylist.map((item) => path.resolve(expandHome(item)))
    const seen = new Set<string>()
    const result: Array<{ path: string; title: string }> = []
    for (const workspace of list) {
      const resolved = path.resolve(String(workspace?.path ?? ''))
      if (!resolved || seen.has(resolved)) continue
      if (allow.length > 0 && !allow.some((prefix) => pathWithin(prefix, resolved))) continue
      if (deny.some((prefix) => pathWithin(prefix, resolved))) continue
      seen.add(resolved)
      result.push({
        path: resolved,
        title: String(workspace?.title ?? workspace?.name ?? path.basename(resolved)),
      })
      if (result.length >= this.config.maxWorkspaces) break
    }
    return result
  }

  /** Stage 1: cheap metadata-only attention measurement. No file contents. */
  private async observe(workspace: { path: string; title: string }): Promise<WorkspaceActivity | undefined> {
    const cutoff = Date.now() - this.config.activeWindowHours * 60 * 60 * 1_000
    const recent: RecentFile[] = []
    let visited = 0
    const walk = async (dir: string): Promise<void> => {
      if (recent.length >= this.config.maxFilesPerWorkspace || visited > 5_000) return
      let entries: any[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (recent.length >= this.config.maxFilesPerWorkspace || visited > 5_000) return
        visited += 1
        const name = String(entry.name)
        const absolute = path.join(dir, name)
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(name) || name.startsWith('.git')) continue
          await walk(absolute)
          continue
        }
        if (!entry.isFile()) continue
        const extension = path.extname(name).toLowerCase()
        if (!TEXT_EXTENSIONS.has(extension) || SECRET_NAMES.test(absolute)) continue
        try {
          const stat = await fs.stat(absolute)
          if (stat.size > 250_000 || stat.mtimeMs < cutoff) continue
          recent.push({
            absolute,
            relative: path.relative(workspace.path, absolute),
            mtime: stat.mtimeMs,
            size: stat.size,
          })
        } catch {
          // A file can disappear while scanning.
        }
      }
    }
    await walk(workspace.path)
    recent.sort((left, right) => right.mtime - left.mtime)
    const gitStatus = await this.git(workspace.path, ['status', '--porcelain'])
    const gitDiff = await this.git(workspace.path, ['diff', '--stat'])
    const changed = gitStatus.split('\n').filter((line) => line.trim() !== '').length
    if (recent.length === 0 && changed === 0) return undefined
    const latest = recent[0]?.mtime ?? 0
    const ageHours = latest ? Math.max(0, (Date.now() - latest) / 3_600_000) : this.config.activeWindowHours
    // Recency dominates; number of touched files and git churn add evidence.
    const score = (1 / (1 + ageHours)) * 50 + Math.min(recent.length, 30) * 2 + Math.min(changed, 20) * 3
    const latestFile = recent[0]?.relative ?? 'git working tree'
    return {
      path: workspace.path,
      title: workspace.title,
      recent,
      gitStatus,
      gitDiff,
      score,
      focus: `${recent.length} files modified in the last ${this.config.activeWindowHours}h; latest: ${latestFile} (${ageHours.toFixed(1)}h ago); git entries: ${changed}`,
    }
  }

  /** Stage 2: read only the focused workspace's recent snippets. */
  private async collect(activity: WorkspaceActivity): Promise<WorkspaceEvidence> {
    let snippets = ''
    for (const file of activity.recent) {
      if (snippets.length >= this.config.maxSnippetChars) break
      try {
        const text = await fs.readFile(file.absolute, 'utf8')
        const room = this.config.maxSnippetChars - snippets.length
        const clipped = text.slice(0, Math.min(room, 4_000))
        if (!clipped.trim()) continue
        snippets += `\n--- ${file.relative} ---\n${clipped}\n`
      } catch {
        // Binary or unreadable file.
      }
    }
    return {
      path: activity.path,
      title: activity.title,
      files: activity.recent.map((file) => file.relative),
      snippets: snippets.slice(0, this.config.maxSnippetChars),
      gitStatus: activity.gitStatus.slice(0, 4_000),
      gitDiff: activity.gitDiff.slice(0, 4_000),
      focus: activity.focus,
    }
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    try {
      const result = await execFileAsync('git', ['-C', cwd, ...args], {
        timeout: 5_000,
        maxBuffer: 250_000,
        windowsHide: true,
      })
      return String(result.stdout ?? '')
    } catch {
      return ''
    }
  }

  private hasBudget(state: ProactiveState): boolean {
    if (this.config.maxMessagesPerDay <= 0) return false
    const now = Date.now()
    if (state.lastNotifiedAt && now - state.lastNotifiedAt < this.config.minGapMinutes * 60_000) {
      return false
    }
    if (state.day !== localDay()) return true
    return (state.count ?? 0) < this.config.maxMessagesPerDay
  }

  private wasSeen(state: ProactiveState, key: string): boolean {
    const at = state.seen[key]
    if (!at) return false
    if (Date.now() - at > SEEN_TTL_MS) {
      delete state.seen[key]
      return false
    }
    return true
  }

  private quietNow(): boolean {
    const bounds = this.config.quietHours.split('-').map((part) => parseClock(part.trim()))
    if (bounds.length !== 2 || bounds[0] === undefined || bounds[1] === undefined) return false
    const [start, end] = bounds
    const minutes = new Date().getHours() * 60 + new Date().getMinutes()
    return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end
  }

  private async loadState(): Promise<ProactiveState> {
    if (this.state) return this.state
    try {
      const raw = await fs.readFile(path.join(this.options.dataDir, STATE_FILE), 'utf8')
      const parsed = JSON.parse(raw) as Partial<ProactiveState>
      this.state = {
        version: 1,
        seen: parsed?.seen && typeof parsed.seen === 'object' ? { ...parsed.seen } : {},
        ...(Number.isFinite(parsed?.lastScanAt) ? { lastScanAt: Number(parsed.lastScanAt) } : {}),
        ...(Number.isFinite(parsed?.lastNotifiedAt) ? { lastNotifiedAt: Number(parsed.lastNotifiedAt) } : {}),
        ...(typeof parsed?.day === 'string' ? { day: parsed.day } : {}),
        ...(Number.isFinite(parsed?.count) ? { count: Number(parsed.count) } : {}),
      }
    } catch {
      this.state = { version: 1, seen: {} }
    }
    return this.state
  }

  private async saveState(state: ProactiveState): Promise<void> {
    this.state = state
    await fs.mkdir(this.options.dataDir, { recursive: true })
    const file = path.join(this.options.dataDir, STATE_FILE)
    const temp = `${file}.tmp`
    await fs.writeFile(temp, JSON.stringify(state, null, 2), 'utf8')
    await fs.rename(temp, file)
  }
}

function findingKey(workspace: string, file: string, kind: string, why: string): string {
  return createHash('sha256')
    .update(`${workspace}\u0000${file}\u0000${kind}\u0000${why}`)
    .digest('hex')
    .slice(0, 24)
}

function localDay(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function parseClock(value: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value)
  if (!match) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return undefined
  return hours * 60 + minutes
}

function pathWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function expandHome(value: string): string {
  if (value === '~') return process.env.HOME || value
  if (value.startsWith('~/')) return path.join(process.env.HOME || '~', value.slice(2))
  return value
}
