import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { StateStore } from '../lib/state.js'
import { canTransition, makeTask, transitionTask, validateState } from '../lib/tasks.js'
import { emptyState } from '../lib/types.js'

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'dsh-dot-task-'))
}

function legacyProposal() {
  return {
    id: 'proposal_1',
    title: 'A pending proposal',
    description: 'Description',
    proposedAction: 'Draft a reply',
    actionType: 'draft_reply',
    source: 'test',
    evidence: 'test evidence',
    risk: 'medium',
    riskReason: 'local write',
    decision: 'ask',
    status: 'pending',
    executionTools: ['write'],
    executionInstruction: 'Write a file',
    createdAt: 1,
    updatedAt: 1,
  }
}

test('v1 state migrates to v2, backs up once, and preserves proposals', async () => {
  const dir = await tempDir()
  try {
    const legacy = {
      version: 1,
      dotSessionId: 'session-dot-v1',
      proposals: [legacyProposal()],
      tasks: [
        {
          id: 'task_active',
          goal: 'Finish legacy work',
          progress: 'Halfway',
          nextStep: 'Continue',
          createdAt: 1,
          updatedAt: 2,
          status: 'active',
        },
        {
          id: 'task_done',
          goal: 'Completed legacy work',
          progress: 'Verified by evidence',
          nextStep: 'None',
          createdAt: 3,
          updatedAt: 4,
          status: 'done',
        },
      ],
      triggers: [],
      pendingAuto: [],
    }
    await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(legacy), 'utf8')

    const store = new StateStore(dir)
    await store.ensureLoaded()
    assert.equal(store.state.version, 2)
    assert.equal(store.state.dotSessionId, 'session-dot-v1')
    assert.equal(store.state.proposals.length, 1)
    assert.equal(store.state.tasks.length, 2)
    assert.equal(store.state.tasks.find((task) => task.id === 'task_active').status, 'blocked')
    assert.equal(store.state.tasks.find((task) => task.id === 'task_active').blockedReason, 'legacy_task_needs_adoption')
    assert.equal(store.state.tasks.find((task) => task.id === 'task_done').status, 'done')
    assert.equal(store.state.tasks.find((task) => task.id === 'task_done').verifiedResult, 'Verified by evidence')
    assert.equal(store.state.focusedTaskId, 'task_active')
    assert.deepEqual(store.state.workers, [])

    const backup = await fs.readFile(store.v1BackupFile, 'utf8')
    assert.equal(JSON.parse(backup).version, 1)
    await store.mutate((state) => {
      state.tasks[0].plan = 'Migrated in memory'
    })
    const backupAfter = await fs.readFile(store.v1BackupFile, 'utf8')
    assert.equal(backupAfter, backup)
    const persisted = JSON.parse(await fs.readFile(store.file, 'utf8'))
    assert.equal(persisted.version, 2)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('v2 state round-trips task, focus, and worker fields', async () => {
  const dir = await tempDir()
  try {
    const state = emptyState()
    const task = makeTask('Round trip', 'Keep going')
    task.status = 'running'
    task.workerId = 'worker_1'
    state.tasks.push(task)
    state.focusedTaskId = task.id
    state.workers.push({
      id: 'worker_1',
      taskId: task.id,
      sessionId: 'session-worker-1',
      status: 'running',
      brief: 'Do it',
      startedAt: 1,
      updatedAt: 2,
      turns: 1,
    })
    await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(state), 'utf8')

    const store = new StateStore(dir)
    await store.ensureLoaded()
    assert.equal(store.state.version, 2)
    assert.equal(store.state.focusedTaskId, task.id)
    assert.equal(store.state.tasks[0].title, 'Round trip')
    assert.equal(store.state.workers[0].sessionId, 'session-worker-1')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('task transitions and state invariants reject unsafe states', () => {
  const task = makeTask('Transition task', 'Start')
  transitionTask(task, 'running', 'Worker started')
  transitionTask(task, 'coordinating', 'Worker returned')
  task.verifiedResult = 'Tests passed'
  transitionTask(task, 'done', 'Completed with evidence')
  assert.equal(task.status, 'done')
  assert.equal(task.events.at(-1).type, 'status_changed')
  assert.equal(canTransition('done', 'running'), false)
  assert.throws(() => transitionTask(task, 'running', 'Invalid'), /invalid task transition/)

  const missingEvidence = emptyState()
  const done = makeTask('Done without evidence')
  done.status = 'done'
  missingEvidence.tasks.push(done)
  assert.throws(() => validateState(missingEvidence), /done without evidence/)

  const duplicateWorkers = emptyState()
  const running = makeTask('Two workers')
  running.status = 'running'
  duplicateWorkers.tasks.push(running)
  for (const id of ['worker_a', 'worker_b']) {
    duplicateWorkers.workers.push({
      id,
      taskId: running.id,
      sessionId: `session-${id}`,
      status: 'running',
      brief: 'x',
      startedAt: 1,
      updatedAt: 1,
      turns: 0,
    })
  }
  assert.throws(() => validateState(duplicateWorkers), /more than one active worker/)

  const missingFocus = emptyState()
  missingFocus.tasks.push(makeTask('Focus'))
  missingFocus.focusedTaskId = 'task_missing'
  assert.throws(() => validateState(missingFocus), /focused task does not exist/)
})
