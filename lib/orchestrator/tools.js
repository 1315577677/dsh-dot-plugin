import { registerMemoryTools } from '../memory/tools.js';
function plainResult(value) {
    if (value === undefined)
        return null;
    return JSON.parse(JSON.stringify(value));
}
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
        const execute = tool.execute;
        const safeTool = {
            ...tool,
            execute: async (...args) => plainResult(await execute(...args)),
        };
        agentCtx.effect(() => agentCtx.tools.register(safeTool), `dsh-dot: supervisor tool ${tool.name}`);
    };
    const onlyDot = (exec, name) => {
        if (!exec.agent || String(exec.agent.id) !== String(agent.id)) {
            throw new Error(`${name} is available only to the Dot supervisor`);
        }
    };
    // Long-term memory: cross-session facts and recall. Registered only when the
    // runtime exposes a memory handle, so the tool layer stays usable without it.
    const memory = runtime.memory;
    if (memory)
        registerMemoryTools(agentCtx, memory, agent);
    register({
        name: 'dot_say',
        description: 'Send one short, plain-text message to the user in the Dot chat, like a text message. Use it for a quick acknowledgment, an occasional progress note, a question, or the final result. You may call it more than once, but never several calls in the same batch: send one, let the step end, then send the next after its result. Two short messages in a row read as human; one long structured message does not. No headings, no "Task:" prefixes, no markdown. Do not rely on internal assistant text.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                text: { type: 'string', description: 'What you would actually text the user: plain, short, no template header, no markdown.' },
                reply_to: {
                    type: 'string',
                    description: 'Optional: id of the earlier user message this reply answers. Use it when replying across messages; omit it for the latest message.',
                },
            },
            required: ['text'],
        },
        output,
        presentCall: genericCall('Say something to the user'),
        async execute(args, exec) {
            onlyDot(exec, 'dot_say');
            const message = await runtime.appendDotSay(String(args?.text ?? ''), typeof args?.reply_to === 'string' ? args.reply_to : undefined);
            return { ok: true, message };
        },
    });
    register({
        name: 'dot_list_workspaces',
        description: 'List the DSH workspaces Dot can assign a task to. Use this before creating a task for another project.',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output,
        presentCall: genericCall('List DSH workspaces'),
        async execute(_args, exec) {
            onlyDot(exec, 'dot_list_workspaces');
            return { ok: true, workspaces: await runtime.listWorkspaces() };
        },
    });
    register({
        name: 'dot_create_task',
        description: 'Create one durable task for a user request, optionally in a target workspace. Use dot_list_workspaces first when the request belongs to another DSH project. It never executes work.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                title: { type: 'string', description: 'Short task title.' },
                request: { type: 'string', description: 'The user request in their own terms.' },
                priority: { type: 'string', enum: ['low', 'normal', 'high'] },
                next_action: { type: 'string', description: 'Smallest concrete next step.' },
                plan: { type: 'string', description: 'Short plan, if known.' },
                workspace: { type: 'string', description: 'Absolute target workspace path, or a workspace id from dot_list_workspaces. Omit for the current default workspace.' },
                dedupe_key: { type: 'string', description: 'Optional idempotency hint for a repeated request.' },
            },
            required: ['title'],
        },
        output,
        presentCall: genericCall('Create a Dot task'),
        async execute(args, exec) {
            onlyDot(exec, 'dot_create_task');
            const result = await runtime.createTask({
                title: String(args?.title ?? ''),
                request: typeof args?.request === 'string' ? args.request : undefined,
                priority: args?.priority,
                nextAction: typeof args?.next_action === 'string' ? args.next_action : undefined,
                plan: typeof args?.plan === 'string' ? args.plan : undefined,
                workspace: typeof args?.workspace === 'string' ? args.workspace : undefined,
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
            return { ok: true, task: await runtime.focusTask(String(args?.task_id ?? '')) };
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
        description: 'Delegate a task with no active worker to the coordinator. It accepts planned, blocked, or running-without-worker tasks and sets the task to running. It starts a worker if a slot is free, otherwise queues the task. The worker gets its own Session and is allowed to read, write, edit, and run commands inside the task assigned workspace.',
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
                ...(await runtime.assignWorker(String(args?.task_id ?? ''), String(args?.brief ?? ''))),
            };
        },
    });
    register({
        name: 'dot_ask_worker',
        description: 'Ask an existing background worker session for a fresh status or clarification without changing the task status. Use it when the user asks about progress on an existing commitment; the reply will arrive as a worker event.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                worker_id: { type: 'string', description: 'Worker id from the task detail.' },
                question: { type: 'string', description: 'The question to send to that worker session.' },
            },
            required: ['worker_id', 'question'],
        },
        output,
        presentCall: genericCall('Ask the background worker'),
        async execute(args, exec) {
            onlyDot(exec, 'dot_ask_worker');
            const workerId = String(args?.worker_id ?? '');
            const question = String(args?.question ?? '');
            if (!workerId || !question.trim())
                throw new Error('worker_id and question are required');
            return runtime.askWorker(workerId, question);
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
    register({
        name: 'dot_get_worker_limit',
        description: 'Read the worker capacity snapshot: the current limit, the allowed range, which workers and tasks are running, and which tasks are queued. Use it when the user asks how many helpers you have, who is busy, or what is waiting.',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output,
        presentCall: genericCall('Read worker capacity'),
        isConcurrencySafe: () => true,
        async execute(_args, exec) {
            onlyDot(exec, 'dot_get_worker_limit');
            return { ok: true, ...runtime.coordinator.capacityView() };
        },
    });
    register({
        name: 'dot_set_worker_limit',
        description: 'Change how many worker slots Dot has. Pass limit for an absolute value or delta for an increment (usually +1), never both. Call it only after the user clearly agrees. Raising it starts queued tasks immediately; lowering it never stops a worker that is already running.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                limit: { type: 'integer', description: 'Absolute number of slots, 2-8.' },
                delta: { type: 'integer', description: 'Relative change, usually 1 or -1.' },
                reason: { type: 'string', description: 'Why the limit changes; for the user-facing record only.' },
            },
        },
        output,
        presentCall: genericCall('Change worker capacity'),
        async execute(args, exec) {
            onlyDot(exec, 'dot_set_worker_limit');
            const limit = Number(args?.limit);
            const delta = Number(args?.delta);
            const hasLimit = Number.isFinite(limit);
            const hasDelta = Number.isFinite(delta);
            if (hasLimit && hasDelta)
                throw new Error('worker_limit_ambiguous: pass limit or delta, not both');
            if (!hasLimit && !hasDelta)
                throw new Error('worker_limit_required: pass limit or delta');
            const requested = hasLimit ? Math.trunc(limit) : runtime.coordinator.limit + Math.trunc(delta);
            const result = await runtime.coordinator.setLimit(requested);
            return { ok: true, ...result, ...runtime.coordinator.capacityView() };
        },
    });
}
