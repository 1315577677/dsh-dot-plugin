import assert from 'node:assert/strict'
import test from 'node:test'
import { registerDotTools } from '../lib/tools.js'

function fakeCtx() {
  const tools = []
  const ctx = {
    effect(fn) {
      fn()
      return () => {}
    },
    tools: {
      register(tool) {
        tools.push(tool.name)
      },
    },
  }
  return { ctx, tools }
}

const runtime = {
  tasks: {
    create: async () => ({ task: {}, deduped: false }),
    update: async () => ({}),
    list: async () => [],
    detail: async () => ({}),
    focus: async () => ({}),
    attachArtifact: async () => ({}),
    complete: async () => ({}),
  },
  proposeAction: async () => ({}),
  addTask: async () => ({}),
  updateTask: async () => ({}),
  scheduleTask: async () => ({}),
  registerTrigger: async () => ({}),
  getScopedState: () => ({}),
}

const agent = { id: 'session-dot-test' }

test('orchestrator mode registers supervisor tools and no legacy task tools', () => {
  const { ctx, tools } = fakeCtx()
  registerDotTools(ctx, runtime, agent, true)
  assert.ok(tools.includes('dot_say'))
  assert.ok(tools.includes('dot_ask_worker'))
  assert.ok(tools.includes('dot_list_workspaces'))
  assert.ok(tools.includes('dot_cancel_task'))
  assert.ok(tools.includes('dot_append_task'))
  assert.ok(tools.includes('dot_create_task'))
  assert.ok(tools.includes('dot_list_tasks'))
  assert.ok(tools.includes('dot_task_detail'))
  assert.ok(tools.includes('dot_complete_task'))
  assert.ok(tools.includes('dot_assign_worker'))
  assert.ok(tools.includes('dot_list_schedules'))
  assert.ok(tools.includes('dot_cancel_schedule'))
  assert.ok(tools.includes('dot_update_schedule'))
  assert.equal(tools.filter((name) => name === 'dot_update_task').length, 1)
  assert.ok(!tools.includes('dot_add_task'))
})

test('legacy mode keeps the old task tools and does not register supervisor tools', () => {
  const { ctx, tools } = fakeCtx()
  registerDotTools(ctx, runtime, agent, false)
  assert.ok(tools.includes('dot_add_task'))
  assert.ok(tools.includes('dot_update_task'))
  assert.ok(tools.includes('dot_list_state'))
  assert.ok(!tools.includes('dot_create_task'))
  assert.ok(!tools.includes('dot_assign_worker'))
})
