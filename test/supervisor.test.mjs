import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { StateStore } from '../lib/state.js'
import { TaskService } from '../lib/orchestrator/task-service.js'

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-dot-supervisor-'))
  const store = new StateStore(dir)
  await store.ensureLoaded()
  return { dir, store, tasks: new TaskService(store) }
}

test('task service creates, dedupes, focuses, and lists tasks', async () => {
  const { dir, store, tasks } = await setup()
  try {
    const first = await tasks.create({
      title: 'Investigate the inbox',
      request: 'Find anything urgent in the inbox',
      nextAction: 'Read the inbox',
      priority: 'high',
    })
    assert.equal(first.deduped, false)
    assert.equal(first.task.status, 'planned')
    assert.equal(store.state.focusedTaskId, first.task.id)

    const duplicate = await tasks.create({
      title: 'Investigate the inbox',
      request: 'Find anything urgent in the inbox',
      nextAction: 'Read the inbox',
    })
    assert.equal(duplicate.deduped, true)
    assert.equal(duplicate.task.id, first.task.id)

    const second = await tasks.create({ title: 'Draft the agenda' })
    await tasks.focus(second.task.id)
    assert.equal(store.state.focusedTaskId, second.task.id)
    const list = await tasks.list()
    assert.equal(list.length, 2)
    assert.equal(list[0].id, second.task.id)
    assert.equal(list[0].focused, true)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('task service updates status, plan, and exposes detail', async () => {
  const { dir, tasks } = await setup()
  try {
    const { task } = await tasks.create({ title: 'Ship the draft' })
    const updated = await tasks.update(task.id, {
      status: 'running',
      plan: 'Draft the file',
      nextAction: 'Write to staging',
    })
    assert.equal(updated.status, 'running')
    assert.equal(updated.plan, 'Draft the file')
    assert.equal(updated.nextAction, 'Write to staging')

    await tasks.update(task.id, {
      status: 'waiting_user',
      waitingFor: 'Approve the target path',
    })
    assert.equal(updated.status, 'waiting_user')
    assert.equal(updated.waitingFor, 'Approve the target path')

    await tasks.update(task.id, { status: 'coordinating' })
    const detail = await tasks.detail(task.id)
    assert.equal(detail.task.status, 'coordinating')
    assert.equal(detail.focused, true)
    assert.ok(detail.task.events.length > 0)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('task completion requires evidence and terminal states are guarded', async () => {
  const { dir, tasks } = await setup()
  try {
    const { task } = await tasks.create({ title: 'Produce an artifact' })
    await tasks.update(task.id, { status: 'running' })
    await assert.rejects(() => tasks.complete(task.id), /without an artifact/)
    await assert.rejects(() => tasks.update(task.id, { status: 'done' }), /cannot be done without an artifact/)

    await tasks.attachArtifact(task.id, {
      title: 'Draft',
      path: '.dsh-dot/staging/task/draft.md',
      kind: 'draft',
    })
    const completed = await tasks.complete(task.id, 'Draft attached and verified.')
    assert.equal(completed.status, 'done')
    assert.equal(completed.artifacts.length, 1)
    assert.equal(completed.verifiedResult, 'Draft attached and verified.')

    await assert.rejects(
      () => tasks.update(task.id, { status: 'running' }),
      /invalid task transition/,
    )
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
