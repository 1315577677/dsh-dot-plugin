import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { StateStore } from '../lib/state.js'
import { TaskService } from '../lib/orchestrator/task-service.js'
import { Coordinator } from '../lib/orchestrator/coordinator.js'
import { transitionTask } from '../lib/tasks.js'

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'dsh-dot-deps-'))
}

async function setup(maxWorkers = 2) {
  const dir = await tempDir()
  const store = new StateStore(dir)
  await store.ensureLoaded()
  const spawned = []
  let nextWorker = 0
  let coordinator
  const tasks = new TaskService(store, () => {}, {
    onTaskSettled: (task) => {
      if (['done', 'failed', 'cancelled'].includes(task.status)) void coordinator?.pump()
    },
  })
  const workers = {
    async spawn(taskId, brief) {
      const workerId = `worker_${++nextWorker}`
      spawned.push(taskId)
      await store.mutate((state) => {
        const task = state.tasks.find((candidate) => candidate.id === taskId)
        if (!task) throw new Error('missing task')
        state.workers.push({
          id: workerId,
          taskId,
          sessionId: `session-${workerId}`,
          status: 'running',
          brief,
          startedAt: Date.now(),
          updatedAt: Date.now(),
          turns: 1,
        })
        task.workerId = workerId
        if (task.status !== 'running') transitionTask(task, 'running', 'Test worker started')
      })
    },
  }
  coordinator = new Coordinator({ store, tasks, workers, maxWorkers })
  return { dir, store, tasks, coordinator, spawned }
}

async function finishWorker(store, taskId) {
  await store.mutate((state) => {
    const worker = state.workers.find(
      (candidate) => candidate.taskId === taskId && candidate.status === 'running',
    )
    if (worker) worker.status = 'idle'
    const task = state.tasks.find((candidate) => candidate.id === taskId)
    if (task && task.status === 'running') transitionTask(task, 'coordinating', 'Test worker returned')
  })
}

async function waitFor(predicate, label, timeoutMs = 2_000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function taskById(store, id) {
  return store.state.tasks.find((task) => task.id === id)
}

test('a dependent task waits for its prerequisite and starts when it completes', async () => {
  const { dir, store, tasks, coordinator, spawned } = await setup()
  try {
    const a = await tasks.create({ title: 'A' })
    const b = await tasks.create({ title: 'B', dependsOn: [a.task.id] })
    assert.deepEqual(b.task.dependsOn, [a.task.id])

    const assignedA = await coordinator.request(a.task.id, 'do A')
    assert.equal(assignedA.started, true)
    const assignedB = await coordinator.request(b.task.id, 'do B')
    assert.equal(assignedB.started, false)
    assert.equal(assignedB.queued, true)
    assert.equal(assignedB.dependencyBlocked, true)
    assert.deepEqual(assignedB.waitingOn, [a.task.id])
    assert.deepEqual(assignedB.waitingOnTitles, ['A'])
    assert.deepEqual(spawned, [a.task.id])

    const listed = await tasks.list()
    assert.deepEqual(listed.find((task) => task.id === b.task.id).waitingOn, [a.task.id])
    const detail = await tasks.detail(b.task.id)
    assert.deepEqual(detail.waitingOnTitles, ['A'])

    await finishWorker(store, a.task.id)
    await tasks.complete(a.task.id, 'A is verified')
    await waitFor(() => spawned.length === 2, 'B to start')
    assert.deepEqual(spawned, [a.task.id, b.task.id])
    assert.equal(taskById(store, b.task.id).status, 'running')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('multiple dependencies must all be done before the task starts', async () => {
  const { dir, store, tasks, coordinator, spawned } = await setup()
  try {
    const a = await tasks.create({ title: 'A' })
    const c = await tasks.create({ title: 'C' })
    const b = await tasks.create({ title: 'B', dependsOn: [a.task.id, c.task.id] })
    await tasks.complete(a.task.id, 'A done')

    const assignedC = await coordinator.request(c.task.id, 'do C')
    assert.equal(assignedC.started, true)
    const assignedB = await coordinator.request(b.task.id, 'do B')
    assert.equal(assignedB.started, false)
    assert.deepEqual(assignedB.waitingOn, [c.task.id])
    assert.deepEqual(spawned, [c.task.id])

    await finishWorker(store, c.task.id)
    await tasks.complete(c.task.id, 'C done')
    await waitFor(() => spawned.length === 2, 'B to start')
    assert.deepEqual(spawned, [c.task.id, b.task.id])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('dependency graph rejects self, missing, and cyclic edges with a path', async () => {
  const { dir, store, tasks } = await setup()
  try {
    const a = await tasks.create({ title: 'A' })
    const b = await tasks.create({ title: 'B', dependsOn: [a.task.id] })
    const c = await tasks.create({ title: 'C', dependsOn: [b.task.id] })

    await assert.rejects(
      () => tasks.update(a.task.id, { dependsOn: [a.task.id] }),
      /dependency_self/,
    )
    await assert.rejects(
      () => tasks.create({ title: 'D', dependsOn: ['task_missing'] }),
      /dependency_missing/,
    )
    const cycle = await tasks.update(a.task.id, { dependsOn: [c.task.id] }).then(
      () => undefined,
      (error) => error,
    )
    assert.match(cycle.message, /dependency_cycle/)
    assert.ok(cycle.message.includes(a.task.id), 'cycle path names A')
    assert.ok(cycle.message.includes(c.task.id), 'cycle path names C')
    assert.deepEqual(taskById(store, a.task.id).dependsOn, [], 'a rejected update leaves the graph unchanged')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('a failed or cancelled dependency never releases the dependent task', async () => {
  const { dir, store, tasks, coordinator, spawned } = await setup()
  try {
    const a = await tasks.create({ title: 'A breaks' })
    const b = await tasks.create({ title: 'B waits', dependsOn: [a.task.id] })
    await coordinator.request(a.task.id, 'do A')
    await coordinator.request(b.task.id, 'do B')
    assert.deepEqual(spawned, [a.task.id])

    await tasks.update(a.task.id, { status: 'failed' })
    await waitFor(() => taskById(store, b.task.id).status === 'blocked', 'B to block')
    const blocked = taskById(store, b.task.id)
    assert.match(blocked.blockedReason, /dependency_blocked/)
    assert.match(blocked.blockedReason, /A breaks/)
    assert.match(blocked.blockedReason, /failed/)
    assert.ok(
      blocked.events.some((event) => event.summary.includes('Dependency unavailable')),
      'blocked event is recorded for the supervisor',
    )
    await coordinator.pump()
    assert.deepEqual(spawned, [a.task.id])

    const c = await tasks.create({ title: 'C breaks' })
    const d = await tasks.create({ title: 'D waits', dependsOn: [c.task.id] })
    await coordinator.request(c.task.id, 'do C')
    await coordinator.request(d.task.id, 'do D')
    await tasks.update(c.task.id, { status: 'cancelled' })
    await waitFor(() => taskById(store, d.task.id).status === 'blocked', 'D to block')
    assert.match(taskById(store, d.task.id).blockedReason, /cancelled/)
    await coordinator.pump()
    assert.ok(!spawned.includes(d.task.id))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('a dependent resumes after its failed prerequisite is retried and completed', async () => {
  const { dir, store, tasks, coordinator, spawned } = await setup()
  try {
    const a = await tasks.create({ title: 'A retry' })
    const b = await tasks.create({ title: 'B resumes', dependsOn: [a.task.id] })
    await coordinator.request(a.task.id, 'do A')
    await coordinator.request(b.task.id, 'do B')
    await tasks.update(a.task.id, { status: 'failed' })
    await waitFor(() => taskById(store, b.task.id).status === 'blocked', 'B to block')
    assert.match(taskById(store, b.task.id).blockedReason, /dependency_blocked/)

    await tasks.update(a.task.id, { status: 'planned' })
    await tasks.complete(a.task.id, 'A retried and verified')
    await waitFor(() => spawned.includes(b.task.id), 'B to resume')
    assert.deepEqual(taskById(store, b.task.id).dependsOn, [a.task.id])
    assert.equal(taskById(store, b.task.id).blockedReason, undefined)
    assert.deepEqual(spawned, [a.task.id, b.task.id])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('a dependency-waiting task yields the slot to a later runnable task', async () => {
  const { dir, store, tasks, coordinator, spawned } = await setup(2)
  try {
    const a = await tasks.create({ title: 'A' })
    const b = await tasks.create({ title: 'B', dependsOn: [a.task.id] })
    const c = await tasks.create({ title: 'C' })
    await tasks.focus(b.task.id)

    await coordinator.request(a.task.id, 'do A')
    const assignedB = await coordinator.request(b.task.id, 'do B')
    assert.equal(assignedB.dependencyBlocked, true)
    assert.equal(assignedB.suggestScaleUp, false, 'a dependency wait is not a capacity problem')
    const assignedC = await coordinator.request(c.task.id, 'do C')
    assert.equal(assignedC.started, true)
    assert.deepEqual(spawned, [a.task.id, c.task.id], 'C starts even though B was queued first')

    await finishWorker(store, a.task.id)
    await tasks.complete(a.task.id, 'A done')
    await waitFor(() => spawned.includes(b.task.id), 'B to start after A completes')
    assert.deepEqual(spawned, [a.task.id, c.task.id, b.task.id])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('dependsOn survives a reload, older tasks default to empty, and updates can clear it', async () => {
  const dir = await tempDir()
  try {
    const store = new StateStore(dir)
    await store.ensureLoaded()
    const tasks = new TaskService(store)
    const a = await tasks.create({ title: 'A' })
    const b = await tasks.create({ title: 'B', dependsOn: [a.task.id] })

    const reloaded = new StateStore(dir)
    await reloaded.ensureLoaded()
    const persistedB = reloaded.state.tasks.find((task) => task.id === b.task.id)
    assert.deepEqual(persistedB.dependsOn, [a.task.id])

    await tasks.update(b.task.id, { dependsOn: [] })
    const cleared = new StateStore(dir)
    await cleared.ensureLoaded()
    assert.deepEqual(cleared.state.tasks.find((task) => task.id === b.task.id).dependsOn, [])

    // v2 state written before this feature has no dependsOn field at all.
    const legacyTasks = cleared.state.tasks.map((task) => {
      const copy = { ...task }
      delete copy.dependsOn
      return copy
    })
    await fs.writeFile(
      path.join(dir, 'state.json'),
      JSON.stringify({ ...cleared.state, tasks: legacyTasks }, null, 2),
      'utf8',
    )
    const legacy = new StateStore(dir)
    await legacy.ensureLoaded()
    assert.deepEqual(legacy.state.tasks.map((task) => task.dependsOn), [[], []])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('loading repairs dangling and cyclic dependency edges instead of dropping state', async () => {
  const dir = await tempDir()
  try {
    const base = {
      id: 'task_a',
      title: 'A',
      request: 'A',
      status: 'planned',
      priority: 'normal',
      createdAt: 1,
      updatedAt: 1,
      plan: 'Not started.',
      nextAction: 'Start.',
      artifacts: [],
      events: [],
      proposalIds: [],
    }
    const state = {
      version: 2,
      proposals: [],
      workers: [],
      chatMessages: [],
      triggers: [],
      pendingAuto: [],
      focusedTaskId: 'task_a',
      tasks: [
        { ...base, id: 'task_a', title: 'A', dependsOn: ['task_b'] },
        { ...base, id: 'task_b', title: 'B', dependsOn: ['task_a', 'task_gone'] },
        { ...base, id: 'task_c', title: 'C', dependsOn: ['task_gone'] },
        { ...base, id: 'task_d', title: 'D', dependsOn: ['task_d'] },
      ],
    }
    await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(state, null, 2), 'utf8')
    const store = new StateStore(dir)
    await store.ensureLoaded()
    const byId = new Map(store.state.tasks.map((task) => [task.id, task]))
    assert.equal(byId.size, 4)
    for (const task of store.state.tasks) {
      for (const dependencyId of task.dependsOn) {
        assert.notEqual(dependencyId, task.id)
        assert.ok(byId.has(dependencyId), `${dependencyId} still exists`)
      }
    }
    assert.deepEqual(byId.get('task_c').dependsOn, [])
    assert.deepEqual(byId.get('task_d').dependsOn, [])
    assert.ok(byId.get('task_a').dependsOn.length + byId.get('task_b').dependsOn.length < 3)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
