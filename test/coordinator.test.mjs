import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { StateStore } from '../lib/state.js'
import { TaskService } from '../lib/orchestrator/task-service.js'
import { Coordinator } from '../lib/orchestrator/coordinator.js'
import { transitionTask } from '../lib/tasks.js'

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-dot-coordinator-'))
  const store = new StateStore(dir)
  await store.ensureLoaded()
  const tasks = new TaskService(store)
  const spawned = []
  let nextWorker = 0
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
  const coordinator = new Coordinator({ store, tasks, workers, maxWorkers: 2 })
  return { dir, store, tasks, coordinator, spawned }
}

async function finishWorker(store, taskId) {
  await store.mutate((state) => {
    const worker = state.workers.find((candidate) => candidate.taskId === taskId && candidate.status === 'running')
    if (worker) worker.status = 'idle'
    const task = state.tasks.find((candidate) => candidate.id === taskId)
    if (task && task.status === 'running') transitionTask(task, 'coordinating', 'Test worker returned')
  })
}

test('coordinator enforces the worker cap and starts queued tasks after a slot frees', async () => {
  const { dir, store, tasks, coordinator, spawned } = await setup()
  try {
    const a = await tasks.create({ title: 'Task A' })
    const b = await tasks.create({ title: 'Task B' })
    const c = await tasks.create({ title: 'Task C' })
    const first = await coordinator.request(a.task.id, 'A')
    const second = await coordinator.request(b.task.id, 'B')
    const third = await coordinator.request(c.task.id, 'C')
    assert.equal(first.started, true)
    assert.equal(second.started, true)
    assert.equal(third.queued, true)
    assert.deepEqual(spawned, [a.task.id, b.task.id])

    await coordinator.focus(c.task.id)
    assert.equal(store.state.focusedTaskId, c.task.id)
    assert.deepEqual(spawned, [a.task.id, b.task.id])

    await finishWorker(store, a.task.id)
    await coordinator.pump()
    assert.deepEqual(spawned, [a.task.id, b.task.id, c.task.id])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('coordinator prefers the focused queued task', async () => {
  const { dir, store, tasks, coordinator, spawned } = await setup()
  try {
    const a = await tasks.create({ title: 'Task A', priority: 'low' })
    const b = await tasks.create({ title: 'Task B', priority: 'high' })
    const c = await tasks.create({ title: 'Task C', priority: 'low' })
    await coordinator.request(a.task.id, 'A')
    await coordinator.request(b.task.id, 'B')
    await coordinator.request(c.task.id, 'C')
    assert.deepEqual(spawned, [a.task.id, b.task.id])
    await coordinator.focus(c.task.id)
    await finishWorker(store, b.task.id)
    await coordinator.pump()
    assert.deepEqual(spawned, [a.task.id, b.task.id, c.task.id])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})


test('coordinator assigns a running task that has no active worker', async () => {
  const { dir, store, tasks, coordinator, spawned } = await setup()
  try {
    const created = await tasks.create({ title: 'Pre-set running task' })
    await tasks.update(created.task.id, { status: 'running' })
    const assigned = await coordinator.request(created.task.id, 'assign after status update')
    assert.equal(assigned.started, true)
    assert.deepEqual(spawned, [created.task.id])
    assert.equal(store.state.tasks[0].status, 'running')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
