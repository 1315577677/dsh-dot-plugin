const output = {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [
        { type: 'text', text: JSON.stringify(value, null, 2) },
    ],
};
const genericCall = (title) => (args) => ({
    card: 'generic',
    title,
    kind: 'other',
    rawInput: args,
});
const STATUSES = [
    'inbox',
    'planned',
    'running',
    'coordinating',
    'waiting_user',
    'blocked',
    'done',
    'failed',
    'cancelled',
];
/** Supervisor-only task tools. Workers never receive these. */
export function registerSupervisorTools(agentCtx, runtime, agent) {
    const register = (tool) => {
        agentCtx.effect(() => agentCtx.tools.register(tool), `dsh-dot: supervisor tool ${tool.name}`);
    };
    const onlyDot = (exec, name) => {
        if (!exec.agent || String(exec.agent.id) !== String(agent.id)) {
            throw new Error(`${name} is available only to the Dot supervisor`);
        }
    };
    register({
        name: 'dot_create_task',
        description: 'Create one durable task for a user request. Use this before delegating substantial work. It never executes work.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                title: { type: 'string', description: 'Short task title.' },
                request: { type: 'string', description: 'The user request in their own terms.' },
                priority: { type: 'string', enum: ['low', 'normal', 'high'] },
                next_action: { type: 'string', description: 'Smallest concrete next step.' },
                plan: { type: 'string', description: 'Short plan, if known.' },
                dedupe_key: { type: 'string', description: 'Optional idempotency hint for a repeated request.' },
            },
            required: ['title'],
        },
        output,
        presentCall: genericCall('Create a Dot task'),
        async execute(args, exec) {
            onlyDot(exec, 'dot_create_task');
            const result = await runtime.tasks.create({
                title: String(args?.title ?? ''),
                request: typeof args?.request === 'string' ? args.request : undefined,
                priority: args?.priority,
                nextAction: typeof args?.next_action === 'string' ? args.next_action : undefined,
                plan: typeof args?.plan === 'string' ? args.plan : undefined,
                dedupeKey: typeof args?.dedupe_key === 'string' ? args.dedupe_key : undefined,
            });
            return { ok: true, ...result };
        },
    });
    register({
        name: 'dot_update_task',
        description: 'Update a task plan, next action, status, priority, waiting reason, or blocker. Use dot_complete_task for completion with evidence.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                task_id: { type: 'string', description: 'Exact task id.' },
                status: { type: 'string', enum: STATUSES },
                plan: { type: 'string' },
                next_action: { type: 'string' },
                waiting_for: { type: 'string' },
                blocked_reason: { type: 'string' },
                priority: { type: 'string', enum: ['low', 'normal', 'high'] },
                verified_result: { type: 'string', description: 'Only when the task should be completed.' },
            },
            required: ['task_id'],
        },
        output,
        presentCall: genericCall('Update a Dot task'),
        async execute(args, exec) {
            onlyDot(exec, 'dot_update_task');
            return {
                ok: true,
                task: await runtime.tasks.update(String(args?.task_id ?? ''), {
                    status: args?.status,
                    plan: typeof args?.plan === 'string' ? args.plan : undefined,
                    nextAction: typeof args?.next_action === 'string' ? args.next_action : undefined,
                    waitingFor: typeof args?.waiting_for === 'string' ? args.waiting_for : undefined,
                    blockedReason: typeof args?.blocked_reason === 'string' ? args.blocked_reason : undefined,
                    priority: args?.priority,
                    verifiedResult: typeof args?.verified_result === 'string' ? args.verified_result : undefined,
                }),
            };
        },
    });
    register({
        name: 'dot_list_tasks',
        description: 'Read the task workspace: all tasks, statuses, priorities, and the focused task.',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output,
        presentCall: genericCall('List Dot tasks'),
        isConcurrencySafe: () => true,
        async execute(_args, exec) {
            onlyDot(exec, 'dot_list_tasks');
            return { ok: true, tasks: await runtime.tasks.list() };
        },
    });
    register({
        name: 'dot_task_detail',
        description: 'Read one task with its events, artifacts, worker reference, and linked proposals.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: { task_id: { type: 'string' } },
            required: ['task_id'],
        },
        output,
        presentCall: genericCall('Read a Dot task'),
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            onlyDot(exec, 'dot_task_detail');
            return { ok: true, ...(await runtime.tasks.detail(String(args?.task_id ?? ''))) };
        },
    });
    register({
        name: 'dot_focus_task',
        description: 'Set the user-facing focused task. It changes priority, not ownership; other tasks continue.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: { task_id: { type: 'string' } },
            required: ['task_id'],
        },
        output,
        presentCall: genericCall('Focus a Dot task'),
        async execute(args, exec) {
            onlyDot(exec, 'dot_focus_task');
            return { ok: true, task: await runtime.tasks.focus(String(args?.task_id ?? '')) };
        },
    });
    register({
        name: 'dot_attach_artifact',
        description: 'Attach a real output to a task. In the orchestrator, this is a staged artifact or an approved result; it does not write the file.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                task_id: { type: 'string' },
                title: { type: 'string' },
                path: { type: 'string' },
                url: { type: 'string' },
                kind: { type: 'string', enum: ['file', 'link', 'report', 'draft'] },
            },
            required: ['task_id', 'title'],
        },
        output,
        presentCall: genericCall('Attach a Dot artifact'),
        async execute(args, exec) {
            onlyDot(exec, 'dot_attach_artifact');
            return {
                ok: true,
                task: await runtime.tasks.attachArtifact(String(args?.task_id ?? ''), {
                    title: String(args?.title ?? ''),
                    path: typeof args?.path === 'string' ? args.path : undefined,
                    url: typeof args?.url === 'string' ? args.url : undefined,
                    kind: args?.kind,
                }),
            };
        },
    });
    register({
        name: 'dot_complete_task',
        description: 'Complete a task only with a verified_result or an attached artifact. This is the evidence gate; do not use dot_update_task to bypass it.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                task_id: { type: 'string' },
                verified_result: { type: 'string', description: 'Concrete evidence that the task is complete.' },
            },
            required: ['task_id'],
        },
        output,
        presentCall: genericCall('Complete a Dot task'),
        async execute(args, exec) {
            onlyDot(exec, 'dot_complete_task');
            return {
                ok: true,
                task: await runtime.tasks.complete(String(args?.task_id ?? ''), typeof args?.verified_result === 'string' ? args.verified_result : undefined),
            };
        },
    });
    register({
        name: 'dot_assign_worker',
        description: 'Delegate a planned task to a worker Agent. The worker gets its own Session, read-only tools, and a staging-only file tool.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                task_id: { type: 'string' },
                brief: { type: 'string', description: 'The exact scope for the worker turn.' },
            },
            required: ['task_id', 'brief'],
        },
        output,
        presentCall: genericCall('Assign a Dot worker'),
        async execute(args, exec) {
            onlyDot(exec, 'dot_assign_worker');
            return {
                ok: true,
                ...(await runtime.workers.spawn(String(args?.task_id ?? ''), String(args?.brief ?? ''))),
            };
        },
    });
    register({
        name: 'dot_continue_worker',
        description: 'Continue an existing worker with a new instruction for the same task.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                task_id: { type: 'string' },
                message: { type: 'string' },
            },
            required: ['task_id', 'message'],
        },
        output,
        presentCall: genericCall('Continue a Dot worker'),
        async execute(args, exec) {
            onlyDot(exec, 'dot_continue_worker');
            return {
                ok: true,
                ...(await runtime.workers.continueForTask(String(args?.task_id ?? ''), String(args?.message ?? ''))),
            };
        },
    });
}
