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
                parentSession: options.parentSession,
                origin: 'subagent',
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
        await Promise.resolve(agent.followup(message));
    }
    status(agent) {
        return String(agent?.status ?? 'idle');
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
    async dispose(agent) {
        await Promise.resolve(agent?.dispose?.());
    }
}
