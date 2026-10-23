import { randomUUID } from 'node:crypto';
export class DshWorkerAgentPort {
    ctx;
    constructor(ctx) {
        this.ctx = ctx;
    }
    async create(options) {
        const handle = await this.ctx.agents.create({
            sessionId: options.sessionId,
            parentAgent: options.parentAgent,
            meta: {
                cwd: options.cwd,
                agentPreset: options.agentPreset,
            },
            agentOptions: options.agentOptions,
            setup: options.setup,
        });
        return { agent: handle.agent, dispose: () => handle.dispose() };
    }
    async resume(options) {
        const handle = await this.ctx.agents.resume({
            resumeSessionId: options.sessionId,
            parentAgent: options.parentAgent,
            agentOptions: options.agentOptions,
            setup: options.setup,
        });
        return { agent: handle.agent, dispose: () => handle.dispose() };
    }
    async followup(agent, message) {
        const notice = {
            id: `dot-worker-notice-${randomUUID()}`,
            role: 'user',
            content: [{ type: 'text', text: message }],
            source: { kind: 'dsh-dot', form: 'notice', summary: 'Dot worker brief' },
        };
        await Promise.resolve(agent.followup(notice));
    }
    status(agent) {
        return String(agent?.status ?? 'idle');
    }
    /**
     * `ctx.agents.get()` is the host's live-Agent registry: an id is present
     * exactly while an Agent handle for that Session exists. A missing id is
     * therefore a positive "nothing can be running" answer, while a failure to
     * ask is `unknown` and must never authorize a replacement worker.
     */
    sessionStatus(sessionId) {
        try {
            const registry = this.ctx?.agents;
            const get = registry?.get;
            if (typeof get !== 'function')
                return 'unknown';
            const agent = get.call(registry, sessionId);
            if (!agent)
                return 'missing';
            const status = String(agent.status ?? '');
            if (status === 'running')
                return 'running';
            if (status === 'idle')
                return 'idle';
            return 'unknown';
        }
        catch {
            return 'unknown';
        }
    }
    result(agent, startIndex) {
        try {
            const events = agent?.session?.snapshotEvents?.() ?? [];
            for (let index = events.length - 1; index >= startIndex; index -= 1) {
                const event = events[index];
                if (event?.type !== 'assistant/message')
                    continue;
                const blocks = event.data?.message?.content ?? [];
                const text = blocks
                    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
                    .map((block) => block.text)
                    .join('\n')
                    .trim();
                if (text)
                    return text;
            }
        }
        catch {
            // A disposed session may no longer be readable.
        }
        return '';
    }
    async append(agent, message) {
        const notice = {
            id: `dot-worker-notice-${randomUUID()}`,
            role: 'user',
            content: [{ type: 'text', text: message }],
            source: { kind: 'dsh-dot', form: 'notice', summary: 'Dot worker addition' },
        };
        if (this.status(agent) === 'running') {
            const steer = agent?.steer ?? agent?.inject;
            if (typeof steer === 'function') {
                await Promise.resolve(steer.call(agent, notice));
                return;
            }
        }
        await this.followup(agent, message);
    }
    async cancel(agent, reason = 'user_cancelled') {
        // Agent.cancel() clears queued input and aborts the active phase. This is
        // what actually stops model/tool work; handle.dispose() then tears down the
        // Agent lifecycle. Calling only dispose on the Agent object was a no-op.
        try {
            await Promise.resolve(agent?.cancel?.({ kind: 'user', reason }));
        }
        catch {
            // Cancellation must still reach the dispose path.
        }
    }
    async dispose(agent) {
        await Promise.resolve(agent?.dispose?.());
    }
}
