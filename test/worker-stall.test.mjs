import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../lib/index.js'
import { StateStore } from '../lib/state.js'
import { TaskService } from '../lib/orchestrator/task-service.js'
import { Coordinator } from '../lib/orchestrator/coordinator.js'
import { WorkerManager } from '../lib/orchestrator/worker-manager.js'

function fakeAgentCtx(tools, guards = []) {
  const listeners = []
  return {
    systemPrompt: { section() {} },
    tools: {
      register(tool) {
        tools.push(tool)
      },
      restrict() {},
      guard(fn) {
        guards.push(fn)
      },
    },
    effect(fn) {
      fn()
      return () => {}
    },
    on(event, cb) {
      listeners.push({ event, cb })
    },
    get(name) {
      if (name === 'agentPresets') return { mount: async () => ({}) }
      return undefined
    },
  }
}

/**
 * Fake host: `sessionStatuses` stands in for ctx.agents.get(). A disposed
 * session moves to `missing`, exactly like the host registry after teardown.
 */
class FakePort {
  constructor() {
    this.agents = new Map()
    this.sessionStatuses = new Map()
    this.followups = []
    this.disposed = []
  }

  async create(options) {
    const tools = []
    const guards = []
    const agent = {
      id: options.sessionId,
      status: 'idle',
      session: { snapshotEvents: () => [] },
    }
    const ctx = fakeAgentCtx(tools, guards)
    await options.setup(ctx, agent)
    this.agents.set(agent.id, { agent, tools, guards })
    this.sessionStatuses.set(agent.id, 'idle')
    return { agent, dispose: async () => this.dispose(agent) }
  }

  async resume() {
    throw new Error('not implemented in fake')
  }

  async followup(agent, message) {
    this.followups.push(message)
    agent.status = 'running'
    this.sessionStatuses.set(agent.id, 'running')
  }

  status(agent) {
    return agent.status
  }

  sessionStatus(sessionId) {
    return this.sessionStatuses.get(sessionId) ?? 'missing'
  }

  result() {
    return 'previous worker result'
  }

  async dispose(agent) {
    agent.status = 'cancelled'
    this.sessionStatuses.set(agent.id, 'missing')
    this.disposed.push(agent.id)
  }
}

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-dot-stall-'))
  const store = new StateStore(dir)
  await store.ensureLoaded()
  const tasks = new TaskService(store)
  const config = resolveConfig({
    orchestrator: true,
    dotWorkspace: dir,
    workerTimeoutMs: 900_000,
    workerStallConfirmMs: 120_000,
    maxWorkers: 4,
  })
  const events = []
  const port = new FakePort()
  const manager = new WorkerManager({
    ctx: { get: () => undefined },
    config,
    store,
    workspace: dir,
    getSupervisor: () => ({ id: 'session-supervisor' }),
    port,
    onEvent: (event) => events.push(event),
  })
  const coordinator = new Coordinator({ store, tasks, workers: manager, maxWorkers: 4 })
  return { dir, store, tasks, manager, coordinator, port, events }
}

function workerOf(store, workerId) {
  return store.state.workers.find((worker) => worker.id === workerId)
}

test('soft timeout marks the task and worker stalled instead of failed', async () => {
  const { dir, store, tasks, manager, port, events } = await setup()
  try {
    const { task } = await tasks.create({ title: 'Long running task' })
    const { worker } = await manager.spawn(task.id, 'Do a long read-only investigation.')
    assert.equal(port.agents.get(worker.sessionId).agent.status, 'running')

    await manager.handleTimeout(worker.id)

    const current = store.state.tasks.find((candidate) => candidate.id === task.id)
    const record = workerOf(store, worker.id)
    assert.equal(current.status, 'blocked')
    assert.match(current.blockedReason, /worker_stalled/)
    assert.equal(record.status, 'stalled')
    assert.equal(record.lastLiveness, 'running')
    assert.ok(record.stalledAt > 0)
    assert.match(record.lastError, /worker_timeout/)
    assert.ok(current.events.some((event) => event.type === 'worker_stalled'))
    assert.ok(!current.events.some((event) => event.type === 'worker_failed'))
    assert.ok(!current.events.some((event) => event.type === 'status_changed' && event.summary === 'Worker failed'))

    // The live session was not killed by elapsed time alone.
    assert.ok(port.agents.has(worker.sessionId))
    assert.equal(port.agents.get(worker.sessionId).agent.status, 'running')
    assert.deepEqual(port.disposed, [])

    const stalledEvent = events.find((event) => event.kind === 'stalled')
    assert.ok(stalledEvent)
    assert.match(stalledEvent.summary, /still running/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('assigning or continuing a task whose timed-out session still runs is refused', async () => {
  const { dir, store, tasks, manager, coordinator, port } = await setup()
  try {
    const { task } = await tasks.create({ title: 'Busy task' })
    const { worker } = await manager.spawn(task.id, 'Start')
    await manager.handleTimeout(worker.id)

    await assert.rejects(() => manager.guardAssignment(task.id), /worker_still_running/)
    await assert.rejects(() => manager.spawn(task.id, 'Take over'), /worker_still_running/)
    await assert.rejects(() => manager.continueForTask(task.id, 'Keep going'), /worker_still_running/)
    await assert.rejects(() => manager.ask(worker.id, 'Any progress?'), /worker_busy/)
    await assert.rejects(() => coordinator.request(task.id, 'Take over'), /worker_still_running/)
    assert.equal(coordinator.queued, 0)
    assert.equal(store.state.workers.length, 1)
    assert.equal(port.agents.get(worker.sessionId).agent.status, 'running')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('a stopped timed-out session may be replaced, with a read-only takeover brief', async () => {
  const { dir, store, tasks, manager, coordinator, port } = await setup()
  try {
    const { task } = await tasks.create({ title: 'Resumable task' })
    const first = await manager.spawn(task.id, 'Implement the first half.')
    // The worker stopped by itself between the timer and the probe.
    const firstAgent = port.agents.get(first.worker.sessionId).agent
    firstAgent.status = 'idle'
    port.sessionStatuses.set(first.worker.sessionId, 'idle')

    await manager.handleTimeout(first.worker.id)
    const stalled = workerOf(store, first.worker.id)
    assert.equal(stalled.status, 'stalled')
    assert.equal(stalled.lastLiveness, 'stopped')
    assert.ok(stalled.stoppedAt > 0)
    assert.ok(port.disposed.includes(first.worker.sessionId))

    await manager.guardAssignment(task.id)
    const assigned = await coordinator.request(task.id, 'Finish the remaining half.')
    assert.equal(assigned.started, true)
    assert.equal(assigned.queued, false)
    const replacement = {
      worker: store.state.workers.find((candidate) => candidate.id === store.state.tasks[0].workerId),
    }

    const followup = port.followups.at(-1)
    assert.match(followup, /^Replacement worker handoff\./)
    assert.match(followup, /Inspect read-only first/)
    assert.match(followup, /Do not overwrite or delete a half-finished file/)
    assert.match(followup, /Finish the remaining half\./)
    assert.match(replacement.worker.brief, /git status/)
    assert.equal(store.state.tasks[0].status, 'running')

    const current = store.state.tasks.find((candidate) => candidate.id === task.id)
    const restartEvent = current.events.find((event) => event.type === 'worker_restarted')
    assert.ok(restartEvent)
    assert.match(restartEvent.summary, new RegExp(first.worker.id))
    assert.match(restartEvent.detail, /liveness probe: stopped/)
    assert.match(restartEvent.detail, /re-dispatched at/)
    assert.equal(workerOf(store, first.worker.id).replacedBy, replacement.worker.id)
    assert.equal(
      store.state.workers.filter((worker) => ['starting', 'running'].includes(worker.status)).length,
      1,
    )
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('unverifiable liveness is refused conservatively and keeps the session', async () => {
  const { dir, store, tasks, manager, port } = await setup()
  try {
    const { task } = await tasks.create({ title: 'Unknown liveness task' })
    const { worker } = await manager.spawn(task.id, 'Start')
    // Neither running nor idle, and the registry cannot answer either.
    const agent = port.agents.get(worker.sessionId).agent
    agent.status = 'suspended'
    port.sessionStatuses.set(worker.sessionId, 'unknown')

    await manager.handleTimeout(worker.id)
    const record = workerOf(store, worker.id)
    assert.equal(record.status, 'stalled')
    assert.equal(record.lastLiveness, 'unknown')
    assert.ok(port.agents.has(worker.sessionId), 'an unverifiable session must not be disposed')

    await assert.rejects(() => manager.guardAssignment(task.id), /worker_liveness_unknown/)
    await assert.rejects(() => manager.spawn(task.id, 'Take over'), /worker_liveness_unknown/)
    await assert.rejects(() => manager.continueForTask(task.id, 'Keep going'), /worker_liveness_unknown/)
    await assert.rejects(() => manager.ask(worker.id, 'Any progress?'), /worker_liveness_unknown/)
    assert.equal(store.state.workers.length, 1)
    assert.equal(workerOf(store, worker.id).replacedBy, undefined)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('the real worker port reads liveness from the live Agent registry', async () => {
  const { DshWorkerAgentPort } = await import('../lib/orchestrator/worker-port.js')
  const running = { status: 'running' }
  const port = new DshWorkerAgentPort({
    agents: { get: (sessionId) => (sessionId === 'session-live' ? running : undefined) },
  })
  assert.equal(port.sessionStatus('session-live'), 'running')
  assert.equal(port.sessionStatus('session-gone'), 'missing')
  assert.equal(new DshWorkerAgentPort({}).sessionStatus('session-x'), 'unknown')
})
