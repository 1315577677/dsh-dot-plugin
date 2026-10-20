/**
 * Human-only slash command. This is the approval surface that works even when
 * a newly installed Client bundle has not been loaded by the current Desktop
 * window yet. The model cannot invoke commands: only a user submission reaches
 * this handler.
 */
export function registerDotCommand(ctx, runtime, log) {
    const commands = ctx.get?.('commands');
    if (!commands?.register) {
        log('dsh-dot: commands service unavailable; /dot approval command was not registered');
        return;
    }
    const handler = async (invocation) => {
        const raw = String(invocation?.rawInput ?? '').trim();
        const [sub = 'status', ...rest] = raw.split(/\s+/).filter(Boolean);
        if (sub === 'status' || sub === 'list') {
            const state = await runtime.getClientState();
            const pending = state.proposals.filter((proposal) => proposal.status === 'pending');
            const lines = [];
            lines.push(`DSH Dot — ${state.dotStatus}`);
            if (pending.length === 0) {
                lines.push('No pending proposals.');
            }
            else {
                lines.push('Pending proposals:');
                pending.forEach((proposal, index) => {
                    const task = proposal.taskId
                        ? state.tasks.find((candidate) => candidate.id === proposal.taskId)
                        : undefined;
                    lines.push(`${index + 1}. [${proposal.risk}] ${proposal.title}${task ? ` — task: ${task.title}` : ''} (${proposal.id.slice(0, 18)}…)`);
                });
                lines.push('Use `/dot approve <n>` or `/dot reject <n>`.');
            }
            if (state.tasks.length > 0) {
                lines.push(`Tracked tasks: ${state.tasks.length}`);
            }
            if (state.schedules.length > 0) {
                lines.push(`Schedules: ${state.schedules.map((schedule) => `${schedule.title} (${schedule.detail})`).join('; ')}`);
            }
            if (state.triggers.length > 0) {
                lines.push(`Triggers: ${state.triggers.map((trigger) => `${trigger.source}/${trigger.condition}`).join('; ')}`);
            }
            if (state.lastError)
                lines.push(`Last error: ${state.lastError}`);
            return { kind: 'success', text: lines.join('\n') };
        }
        if (sub === 'run') {
            const result = await runtime.runResearch('command');
            return {
                kind: result.started ? 'success' : 'error',
                text: result.started
                    ? 'Dot research round started. Open the Dot conversation to follow it.'
                    : `Could not start research: ${result.reason}`,
            };
        }
        if (sub !== 'approve' && sub !== 'reject') {
            return {
                kind: 'error',
                text: 'Usage: /dot [status|approve <n|id>|reject <n|id>|run]',
            };
        }
        const target = rest[0];
        if (!target) {
            return {
                kind: 'error',
                text: `Usage: /dot ${sub} <n|proposal-id>`,
            };
        }
        const state = await runtime.getClientState();
        const pending = state.proposals.filter((proposal) => proposal.status === 'pending');
        const proposal = /^\d+$/.test(target)
            ? pending[Number(target) - 1]
            : pending.find((candidate) => candidate.id === target || candidate.id.startsWith(target));
        if (!proposal) {
            return { kind: 'error', text: `No pending proposal matches "${target}".` };
        }
        if (sub === 'approve') {
            const result = await runtime.approveProposal(proposal.id);
            return result.ok
                ? {
                    kind: 'success',
                    text: `Approved: ${proposal.title}${proposal.taskId ? `\nTask: ${state.tasks.find((task) => task.id === proposal.taskId)?.title ?? proposal.taskId}` : ''}\n${result.proposal?.result ?? 'Dot is executing it in its own Session.'}`,
                }
                : {
                    kind: 'error',
                    text: `Approval failed: ${result.error ?? 'unknown error'}`,
                };
        }
        const note = rest.slice(1).join(' ');
        const result = await runtime.rejectProposal(proposal.id, note || undefined);
        return result.ok
            ? { kind: 'success', text: `Rejected: ${proposal.title}` }
            : {
                kind: 'error',
                text: `Rejection failed: ${result.error ?? 'unknown error'}`,
            };
    };
    ctx.effect(() => commands.register({
        name: 'dot',
        description: 'DSH Dot: list, approve, reject proposals, or run a research round',
        input: {
            hint: '[status|approve <n|id>|reject <n|id>|run]',
        },
        handler,
    }), 'dsh-dot: /dot command');
}
