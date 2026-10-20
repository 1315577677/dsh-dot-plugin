import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../lib/index.js'
import { heuristicRisk } from '../lib/reviewer.js'
import { StateStore } from '../lib/state.js'

test('config normalization keeps real sources and safe defaults', () => {
  const config = resolveConfig({
    sources: [
      {
        id: 'inbox',
        kind: 'directory',
        label: 'Inbox',
        path: 'dot-demo/inbox',
      },
      { id: 'bad', kind: 'directory', label: 'Missing path' },
      { id: 'web', kind: 'url', label: 'Issues', url: 'https://api.github.com/repos/o/r/issues' },
    ],
    readOnlyTools: ['read', 'glob', 'read', ''],
    executionTools: ['write'],
  })
  assert.equal(config.sources.length, 2)
  assert.equal(config.sources[0].kind, 'directory')
  assert.ok(path.isAbsolute(config.sources[0].path))
  assert.deepEqual(config.readOnlyTools, ['read', 'glob'])
  assert.deepEqual(config.executionTools, ['write'])
  assert.equal(config.autoApproveLowRisk, false)
  assert.equal(config.orchestrator, false)
  assert.equal(config.workerTimeoutMs, 900000)
  assert.equal(config.workerMaxTurns, 3)
  assert.equal(config.maxWorkers, 2)
  assert.equal(resolveConfig({ orchestrator: true }).orchestrator, true)
  assert.equal(config.agentPreset, 'standard')
  assert.ok(config.rules.length > 0)
})

test('independent risk heuristic separates send, write, and read proposals', () => {
  const base = {
    title: 'Test',
    description: 'Test',
    actionType: 'test',
    source: 'test',
    evidence: '',
    executionInstruction: '',
  }
  const send = heuristicRisk({
    ...base,
    proposedAction: 'Send the signed invoice by email',
    executionTools: ['send_email'],
  })
  assert.equal(send.risk, 'high')

  const write = heuristicRisk({
    ...base,
    proposedAction: 'Write a local draft to the outbox',
    executionTools: ['write'],
  })
  assert.equal(write.risk, 'medium')

  const read = heuristicRisk({
    ...base,
    proposedAction: 'Read the inbox and summarize it',
    executionTools: [],
  })
  assert.equal(read.risk, 'low')
})

test('state store persists across reloads and survives a corrupt file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-dot-state-'))
  try {
    const store = new StateStore(dir)
    await store.ensureLoaded()
    await store.mutate((state) => {
      state.dotSessionId = 'session-dot-test'
      state.tasks.push({
        id: 'task_1',
        title: 'Persist a task',
        request: 'Persist a task',
        status: 'planned',
        priority: 'normal',
        createdAt: 1,
        updatedAt: 1,
        plan: 'Not started.',
        nextAction: 'Start.',
        artifacts: [],
        events: [],
        proposalIds: [],
      })
    })

    const reloaded = new StateStore(dir)
    await reloaded.ensureLoaded()
    assert.equal(reloaded.state.dotSessionId, 'session-dot-test')
    assert.equal(reloaded.state.tasks.length, 1)

    await fs.writeFile(reloaded.file, '{ not json', 'utf8')
    const recovered = new StateStore(dir)
    await recovered.ensureLoaded()
    assert.equal(recovered.state.dotSessionId, undefined)
    assert.equal(recovered.state.tasks.length, 0)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
