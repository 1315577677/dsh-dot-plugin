import type { DotRuntime } from './runtime.js'
import { registerSupervisorTools } from './orchestrator/tools.js'

type AnyContext = any

function plainResult(value: unknown): any {
  if (value === undefined) return null
  return JSON.parse(JSON.stringify(value))
}

const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args: unknown, value: unknown) => [
    { type: 'text', text: JSON.stringify(value, null, 2) },
  ],
}

const genericCall = (title: string) => (args: unknown) => ({
  card: 'generic',
  title,
  kind: 'other',
  rawInput: args,
})

/**
 * Tools visible only inside the Dot Agent's scope.
 *
 * `dot_propose_action` records a plan; it never executes the plan. The actual
 * execution turn receives a separate tool allowlist only after user approval.
 */
export function registerDotTools(
  agentCtx: AnyContext,
  runtime: DotRuntime,
  agent: any,
  orchestrator = false,
): void {
  if (orchestrator) registerSupervisorTools(agentCtx, runtime, agent)

  const register = (tool: any) => {
    const execute = tool.execute
    const safeTool = {
      ...tool,
      execute: async (...args: any[]) => plainResult(await execute(...args)),
    }
    agentCtx.effect(
      () => agentCtx.tools.register(safeTool),
      `dsh-dot: scoped tool ${tool.name}`,
    )
  }

  register({
    name: 'dot_propose_action',
    description:
      'Propose one concrete action for the user to approve. Use this only after worker evidence, not after your own source research. It records a proposal; it does not execute anything. The user decides in the DSH Dot panel. Approved work runs in a separate executor Agent.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task_id: { type: 'string', description: 'Optional task id this action belongs to.' },
        title: { type: 'string', description: 'Short action title, under 90 characters.' },
        description: {
          type: 'string',
          description: 'Why this matters, including the evidence you found.',
        },
        proposed_action: {
          type: 'string',
          description: 'The exact outcome you will produce if approved.',
        },
        action_type: {
          type: 'string',
          description: 'Stable snake_case category, for example draft_reply or prepare_summary.',
        },
        source: {
          type: 'string',
          description: 'Which configured source or tool produced this finding.',
        },
        evidence: {
          type: 'string',
          description: 'Short quote or reference to the read-only evidence.',
        },
        execution_tools: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Tools the execution turn will need, for example ["write"]. Use only tools listed as available for approved execution.',
        },
        execution_instruction: {
          type: 'string',
          description:
            'The exact instruction for the execution turn, including target path or recipient and a stop condition.',
        },
      },
      required: ['title', 'description', 'proposed_action', 'action_type'],
    },
    output,
    presentCall: genericCall('Propose a Dot action'),
    timeoutMs: 60_000,
    async execute(args: any, exec: any) {
      if (!exec.agent || String(exec.agent.id) !== String(agent.id)) {
        throw new Error('dot_propose_action is available only to the Dot agent')
      }
      return runtime.proposeAction(args, exec.signal)
    },
  })

  if (!orchestrator) {
  register({
    name: 'dot_add_task',
    description:
      'Track a long-running goal in DSH Dot. Use it when a source reveals work that needs multiple steps over time, not for a single action proposal.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        goal: { type: 'string', description: 'The durable goal to track.' },
        next_step: { type: 'string', description: 'The smallest next step, if known.' },
      },
      required: ['goal'],
    },
    output,
    presentCall: genericCall('Track a Dot task'),
    async execute(args: any, exec: any) {
      if (!exec.agent || String(exec.agent.id) !== String(agent.id)) {
        throw new Error('dot_add_task is available only to the Dot agent')
      }
      const goal = typeof args?.goal === 'string' ? args.goal.trim() : ''
      if (!goal) throw new Error('goal is required')
      return { ok: true, task: await runtime.addTask(goal, typeof args?.next_step === 'string' ? args.next_step : '') }
    },
  })

  register({
    name: 'dot_update_task',
    description: 'Update the progress, next step, or status of a tracked DSH Dot task.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task_id: { type: 'string', description: 'Exact task id from dot_list_state.' },
        progress: { type: 'string', description: 'Current verified progress.' },
        next_step: { type: 'string', description: 'Next planned step.' },
        status: { type: 'string', enum: ['active', 'done'], description: 'Task status.' },
      },
      required: ['task_id'],
    },
    output,
    presentCall: genericCall('Update a Dot task'),
    async execute(args: any, exec: any) {
      if (!exec.agent || String(exec.agent.id) !== String(agent.id)) {
        throw new Error('dot_update_task is available only to the Dot agent')
      }
      const taskId = typeof args?.task_id === 'string' ? args.task_id : ''
      if (!taskId) throw new Error('task_id is required')
      const task = await runtime.updateTask(taskId, {
        progress: typeof args?.progress === 'string' ? args.progress : undefined,
        nextStep: typeof args?.next_step === 'string' ? args.next_step : undefined,
        status: args?.status === 'done' ? 'done' : args?.status === 'active' ? 'active' : undefined,
      })
      if (!task) throw new Error('task_not_found')
      return { ok: true, task }
    },
  })

  }

  register({
    name: 'dot_schedule_task',
    description:
      'Create a durable reminder in the Dot Session using the Host schedule service. When due, the prompt wakes Dot for a new research or follow-up turn.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'Short schedule title.' },
        prompt: { type: 'string', description: 'Instruction delivered to Dot when due.' },
        cron_expression: {
          type: 'string',
          description: 'Optional five-field cron expression.',
        },
        every_seconds: {
          type: 'number',
          description: 'Optional fixed interval in seconds, at least 60.',
        },
        time_zone: { type: 'string', description: 'IANA time zone for cron.' },
      },
      required: ['title', 'prompt'],
    },
    output,
    presentCall: genericCall('Schedule a Dot task'),
    async execute(args: any, exec: any) {
      if (!exec.agent || String(exec.agent.id) !== String(agent.id)) {
        throw new Error('dot_schedule_task is available only to the Dot agent')
      }
      const title = typeof args?.title === 'string' ? args.title.trim() : ''
      const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : ''
      if (!title || !prompt) throw new Error('title and prompt are required')
      return {
        ok: true,
        schedule: await runtime.scheduleTask({
          title,
          prompt,
          cronExpression: typeof args?.cron_expression === 'string' ? args.cron_expression : undefined,
          everySeconds: typeof args?.every_seconds === 'number' ? args.every_seconds : undefined,
          timeZone: typeof args?.time_zone === 'string' ? args.time_zone : undefined,
        }),
      }
    },
  })

  register({
    name: 'dot_list_schedules',
    description:
      'List the durable schedules Dot created for this Dot Session. Use it when the user asks what is scheduled or before cancelling/updating one.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output,
    presentCall: genericCall('List Dot schedules'),
    async execute(_args: any, exec: any) {
      if (!exec.agent || String(exec.agent.id) !== String(agent.id)) {
        throw new Error('dot_list_schedules is available only to the Dot agent')
      }
      return { ok: true, schedules: await runtime.listSchedules() }
    },
  })

  register({
    name: 'dot_cancel_schedule',
    description:
      'Cancel one of Dot\'s durable schedules. Use the schedule id returned by dot_schedule_task or dot_list_schedules.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        schedule_id: { type: 'string', description: 'Exact schedule id to cancel.' },
      },
      required: ['schedule_id'],
    },
    output,
    presentCall: genericCall('Cancel a Dot schedule'),
    async execute(args: any, exec: any) {
      if (!exec.agent || String(exec.agent.id) !== String(agent.id)) {
        throw new Error('dot_cancel_schedule is available only to the Dot agent')
      }
      const id = typeof args?.schedule_id === 'string' ? args.schedule_id.trim() : ''
      if (!id) throw new Error('schedule_id is required')
      return { ok: true, result: await runtime.cancelSchedule(id) }
    },
  })

  register({
    name: 'dot_update_schedule',
    description:
      'Update one of Dot\'s durable schedules: title, prompt, cron expression, or fixed interval. Use the exact schedule id.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        schedule_id: { type: 'string', description: 'Exact schedule id to update.' },
        title: { type: 'string', description: 'New short title.' },
        prompt: { type: 'string', description: 'New instruction delivered when due.' },
        cron_expression: { type: 'string', description: 'New five-field cron expression.' },
        every_seconds: { type: 'number', description: 'New fixed interval in seconds, at least 60.' },
        time_zone: { type: 'string', description: 'IANA time zone for the cron expression.' },
      },
      required: ['schedule_id'],
    },
    output,
    presentCall: genericCall('Update a Dot schedule'),
    async execute(args: any, exec: any) {
      if (!exec.agent || String(exec.agent.id) !== String(agent.id)) {
        throw new Error('dot_update_schedule is available only to the Dot agent')
      }
      const id = typeof args?.schedule_id === 'string' ? args.schedule_id.trim() : ''
      if (!id) throw new Error('schedule_id is required')
      return {
        ok: true,
        result: await runtime.updateSchedule(id, {
          title: typeof args?.title === 'string' ? args.title : undefined,
          prompt: typeof args?.prompt === 'string' ? args.prompt : undefined,
          cronExpression: typeof args?.cron_expression === 'string' ? args.cron_expression : undefined,
          everySeconds: typeof args?.every_seconds === 'number' ? args.every_seconds : undefined,
          timeZone: typeof args?.time_zone === 'string' ? args.time_zone : undefined,
        }),
      }
    },
  })

  register({
    name: 'dot_register_trigger',
    description:
      'Register a local event trigger. External systems or tests call the Host dshDot service fireTrigger(id, payload); a match wakes Dot for a read-only investigation.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: { type: 'string', description: 'Event source label, for example email or github.' },
        condition: { type: 'string', description: 'Regular expression tested against the JSON payload.' },
        instruction: { type: 'string', description: 'What Dot should investigate when this fires.' },
      },
      required: ['source', 'condition', 'instruction'],
    },
    output,
    presentCall: genericCall('Register a Dot trigger'),
    async execute(args: any, exec: any) {
      if (!exec.agent || String(exec.agent.id) !== String(agent.id)) {
        throw new Error('dot_register_trigger is available only to the Dot agent')
      }
      const source = typeof args?.source === 'string' ? args.source.trim() : ''
      const condition = typeof args?.condition === 'string' ? args.condition.trim() : ''
      const instruction = typeof args?.instruction === 'string' ? args.instruction.trim() : ''
      if (!source || !condition || !instruction) {
        throw new Error('source, condition, and instruction are required')
      }
      return { ok: true, trigger: await runtime.registerTrigger({ source, condition, instruction }) }
    },
  })

  register({
    name: 'dot_list_state',
    description:
      'Read the current Dot proposals and tasks. This is read-only and useful before proposing another action.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output,
    presentCall: genericCall('Read Dot state'),
    isConcurrencySafe: () => true,
    async execute(_args: any, exec: any) {
      if (!exec.agent || String(exec.agent.id) !== String(agent.id)) {
        throw new Error('dot_list_state is available only to the Dot agent')
      }
      return runtime.getScopedState()
    },
  })
}
