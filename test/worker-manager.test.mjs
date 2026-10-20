import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../lib/index.js'
import { StateStore } from '../lib/state.js'
import { TaskService } from '../lib/orchestrator/task-service.js'
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

class FakePort {
  constructor() {
    this.agents = new Map()
    this.followups = []
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
    return { agent, dispose: async () => {} }
  }
  async resume() {
    throw new Error('not implemented in fake')
  }
  async followup(agent, message) {
    this.followups.push(message)
    agent.status = 'running'
  }
  status(agent) {
    return agent.status
  }
  result() {
    return 'worker result'
  }
  async dispose(agent) {
    agent.status = 'cancelled'
  }
}

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-dot-worker-'))
  const store = new StateStore(dir)
  await store.ensureLoaded()
  const tasks = new TaskService(store)
  const config = resolveConfig({ orchestrator: true, dotWorkspace: dir, workerMaxTurns: 3 })
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
  return { dir, store, tasks, manager, port, events }
}

test('worker manager spawns a scoped worker, stages a file, and returns an event', async () => {
  const { dir, store, tasks, manager, port, events } = await setup()
  try {
    const { task } = await tasks.create({ title: 'Draft the reply' })
    const spawned = await manager.spawn(task.id, 'Inspect the inbox and stage a draft.')
    assert.equal(spawned.task.status, 'running')
    assert.equal(spawned.worker.status, 'running')
    assert.equal(store.state.workers.length, 1)
    await assert.rejects(() => manager.spawn(task.id, 'again'), /task_not_assignable|active_worker/)
    assert.match(port.followups[0], /Inspect the inbox/)
    assert.ok(port.agents.has(spawned.worker.sessionId))
    const { tools, guards } = port.agents.get(spawned.worker.sessionId)
    const names = tools.map((tool) => tool.name)
    assert.ok(names.includes('dot_stage_file'))
    assert.ok(names.includes('dot_worker_report'))
    assert.ok(!names.includes('write'))
    assert.ok(!names.includes('bash'))
    assert.ok(guards.length > 0)
    assert.match(guards[0]({ name: 'read', args: { file_path: '/etc/passwd' } }), /task roots/)

    const stage = tools.find((tool) => tool.name === 'dot_stage_file')
    const exec = { agent: { id: spawned.worker.sessionId } }
    const staged = await stage.execute({ path: 'draft.md', content: 'hello' }, exec)
    assert.equal(staged.ok, true)
    assert.equal(await fs.readFile(path.join(dir, '.dsh-dot', 'staging', task.id, 'draft.md'), 'utf8'), 'hello')
    await assert.rejects(() => stage.execute({ path: '../escape.md', content: 'x' }, exec), /staging_path_escape/)

    const report = tools.find((tool) => tool.name === 'dot_worker_report')
    await report.execute({ summary: 'Draft staged' }, exec)
    assert.ok(store.state.tasks[0].events.some((event) => event.type === 'worker_progress'))

    port.agents.get(spawned.worker.sessionId).agent.status = 'idle'
    await manager.handleIdle(spawned.worker.id)
    assert.equal(store.state.tasks[0].status, 'coordinating')
    assert.equal(events.at(-1).kind, 'idle')
    assert.match(events.at(-1).result, /worker result/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('worker manager continues a worker and enforces max turns', async () => {
  const { dir, tasks, manager, port } = await setup()
  try {
    const { task } = await tasks.create({ title: 'Continue the task' })
    const spawned = await manager.spawn(task.id, 'Start')
    port.agents.get(spawned.worker.sessionId).agent.status = 'idle'
    await manager.handleIdle(spawned.worker.id)

    const continued = await manager.continueForTask(task.id, 'Do the next step')
    assert.equal(continued.task.status, 'running')
    assert.equal(port.followups.length, 2)
    assert.equal(port.followups[1], 'Do the next step')
    port.agents.get(spawned.worker.sessionId).agent.status = 'idle'
    await manager.handleIdle(spawned.worker.id)

    await manager.continueForTask(task.id, 'Third turn')
    port.agents.get(spawned.worker.sessionId).agent.status = 'idle'
    await manager.handleIdle(spawned.worker.id)
    await assert.rejects(() => manager.continueForTask(task.id, 'Fourth turn'), /worker_max_turns_reached/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
