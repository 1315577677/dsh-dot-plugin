import { promises as fs } from 'node:fs'
import path from 'node:path'
import { emptyState, type DotState } from './types.js'

type Log = (message: string, ...args: unknown[]) => void

const STATE_FILE = 'state.json'
const MAX_PROPOSALS = 120

/**
 * Atomic JSON store for the Dot's durable control-plane state.
 *
 * The Agent's Session log remains the source of truth for conversation and
 * tool outcomes. This file stores only plugin-owned records: the Dot Session
 * identity, proposals, tasks, triggers, and the last research bookkeeping.
 */
export class StateStore {
  readonly dataDir: string
  state: DotState = emptyState()

  private loaded?: Promise<void>
  private writeChain: Promise<void> = Promise.resolve()

  constructor(dataDir: string, private readonly log: Log = () => {}) {
    this.dataDir = dataDir
  }

  get file(): string {
    return path.join(this.dataDir, STATE_FILE)
  }

  ensureLoaded(): Promise<void> {
    this.loaded ??= this.load()
    return this.loaded
  }

  private async load(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true })
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<DotState>
      this.state = normalize(parsed)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log('dsh-dot: state load failed; starting empty', error)
      }
      this.state = emptyState()
    }
  }

  async mutate(fn: (state: DotState) => void): Promise<DotState> {
    await this.ensureLoaded()
    fn(this.state)
    this.trim()
    await this.persist()
    return this.state
  }

  async persist(): Promise<void> {
    await this.ensureLoaded()
    const payload = `${JSON.stringify(this.state, null, 2)}\n`
    const temp = path.join(this.dataDir, `.state-${process.pid}-${Date.now()}.json`)
    this.writeChain = this.writeChain
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(this.dataDir, { recursive: true })
        await fs.writeFile(temp, payload, 'utf8')
        await fs.rename(temp, this.file)
      })
      .catch(async (error) => {
        this.log('dsh-dot: state write failed', error)
        await fs.unlink(temp).catch(() => {})
      })
    return this.writeChain
  }

  async flush(): Promise<void> {
    await this.writeChain
  }

  private trim(): void {
    if (this.state.proposals.length > MAX_PROPOSALS) {
      const keep = this.state.proposals
        .slice(0, MAX_PROPOSALS)
        .filter((proposal) => proposal.status === 'pending' || proposal.status === 'executing')
        .map((proposal) => proposal.id)
      this.state.proposals = this.state.proposals.filter(
        (proposal, index) => index < MAX_PROPOSALS || keep.includes(proposal.id),
      )
    }
  }
}

function normalize(parsed: Partial<DotState>): DotState {
  const state = emptyState()
  if (!parsed || parsed.version !== 1) return state
  if (typeof parsed.dotSessionId === 'string') state.dotSessionId = parsed.dotSessionId
  if (Array.isArray(parsed.proposals)) {
    state.proposals = parsed.proposals.filter(isProposal) as DotState['proposals']
  }
  if (Array.isArray(parsed.tasks)) {
    state.tasks = parsed.tasks.filter(isTask) as DotState['tasks']
  }
  if (Array.isArray(parsed.triggers)) {
    state.triggers = parsed.triggers.filter(isTrigger) as DotState['triggers']
  }
  if (Number.isFinite(parsed.lastResearchAt)) state.lastResearchAt = Number(parsed.lastResearchAt)
  if (Number.isFinite(parsed.lastResearchCompletedAt)) {
    state.lastResearchCompletedAt = Number(parsed.lastResearchCompletedAt)
  }
  if (typeof parsed.lastError === 'string') state.lastError = parsed.lastError
  if (Array.isArray(parsed.pendingAuto)) {
    state.pendingAuto = parsed.pendingAuto.filter((id): id is string => typeof id === 'string')
  }
  if (typeof parsed.executingId === 'string') state.executingId = parsed.executingId
  return state
}

function isProposal(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const proposal = value as Record<string, unknown>
  return (
    typeof proposal.id === 'string' &&
    typeof proposal.title === 'string' &&
    typeof proposal.status === 'string' &&
    typeof proposal.risk === 'string'
  )
}

function isTask(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const task = value as Record<string, unknown>
  return typeof task.id === 'string' && typeof task.goal === 'string'
}

function isTrigger(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const trigger = value as Record<string, unknown>
  return typeof trigger.id === 'string' && typeof trigger.source === 'string'
}
