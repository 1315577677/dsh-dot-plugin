import type { DotTaskV2, WorkerRecord } from '../types.js'
import type { WorkerManager } from './worker-manager.js'

type AnyContext = any

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

/** Tools exposed only to one worker Agent. No generic write/edit/bash. */
export function registerWorkerTools(
  agentCtx: AnyContext,
  manager: WorkerManager,
  worker: WorkerRecord,
  task: DotTaskV2,
  stagingDir: string,
): void {
  const register = (tool: any) => {
    agentCtx.effect(
      () => agentCtx.tools.register(tool),
      `dsh-dot: worker tool ${tool.name}`,
    )
  }
  const onlyWorker = (exec: any, name: string) => {
    if (!exec.agent || String(exec.agent.id) !== String(worker.sessionId)) {
      throw new Error(`${name} is available only to this worker`)
    }
  }

  register({
    name: 'dot_worker_report',
    description:
      'Report a short progress update for the current task. Do not dump logs. The supervisor receives a task event.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        summary: { type: 'string', description: 'One or two sentences of verified progress.' },
        next: { type: 'string', description: 'The next concrete step, if known.' },
      },
      required: ['summary'],
    },
    output,
    presentCall: genericCall('Report worker progress'),
    async execute(args: any, exec: any) {
      onlyWorker(exec, 'dot_worker_report')
      return manager.report(worker.id, String(args?.summary ?? ''), typeof args?.next === 'string' ? args.next : '')
    },
  })

  register({
    name: 'dot_stage_file',
    description:
      'Write a file inside this task staging directory only. Use a relative path. Real workspace writes require a user-approved proposal.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Path relative to the task staging directory.' },
        content: { type: 'string', description: 'UTF-8 file content.' },
      },
      required: ['path', 'content'],
    },
    output,
    presentCall: genericCall('Stage a worker file'),
    async execute(args: any, exec: any) {
      onlyWorker(exec, 'dot_stage_file')
      return manager.writeStaging(
        worker.id,
        String(args?.path ?? ''),
        String(args?.content ?? ''),
      )
    },
  })

  // The prompt names these values; keep the closure's task identity visible to
  // the model-facing metadata without exposing the manager itself.
  void task
  void stagingDir
}
