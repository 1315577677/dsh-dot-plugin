"use strict";
/**
 * DSH Dot Client panel.
 *
 * A dedicated main panel plus a sidebar icon. The panel is the user-only
 * control surface: it reads proposals and submits approve/reject decisions.
 * The Dot Agent has no Tool that can call these endpoints.
 */
const NS = 'dsh-dot';
const zh = {
    title: 'DSH Dot',
    subtitle: '常驻研究 Agent · 只读研究 · 用户批准后执行',
    openConversation: '打开 Dot 会话',
    runNow: '立即研究',
    running: 'Dot 正在工作',
    idle: '空闲',
    starting: '启动中',
    error: '出错',
    pending: '待批准',
    recent: '最近',
    sources: '数据源',
    noSources: '尚未配置数据源。',
    lastResearch: '上次研究',
    never: '从未',
    riskLow: '低风险',
    riskMedium: '中风险',
    riskHigh: '高风险',
    approve: '批准执行',
    reject: '拒绝',
    working: '处理中…',
    proposedAction: '执行内容',
    executionTools: '执行工具',
    evidence: '证据',
    riskReason: '风险判断',
    noProposals: '当前没有待批准的行动。Dot 会在后台进行只读研究。',
    noSession: 'Dot 会话尚未创建。',
    refreshed: '已更新',
    approved: '已批准，Dot 正在执行。',
    rejected: '已拒绝。',
    failed: '操作失败',
    approvedStatus: '已批准',
    executingStatus: '执行中',
    executedStatus: '已执行',
    rejectedStatus: '已拒绝',
    failedStatus: '失败',
    pendingStatus: '待批准',
    errorRead: '无法读取 DSH Dot 状态。',
    autoNote: '批准是用户独占操作；Dot 不能批准自己。',
    executionResult: '执行结果',
    tasks: '长期任务',
    emptyTasks: '暂无长期任务。',
    schedules: '定时任务',
    triggers: '事件触发器',
    emptySchedules: '暂无定时任务。',
    emptyTriggers: '暂无事件触发器。',
    condition: '条件',
    detail: '计划',
};
const en = {
    title: 'DSH Dot',
    subtitle: 'Persistent research agent · read-only research · execute only after approval',
    openConversation: 'DSH Dot conversation',
    runNow: 'Run research now',
    running: 'Dot is working',
    idle: 'Idle',
    starting: 'Starting',
    error: 'Error',
    pending: 'Pending',
    recent: 'Recent',
    sources: 'Sources',
    noSources: 'No sources configured yet.',
    lastResearch: 'Last research',
    never: 'Never',
    riskLow: 'Low risk',
    riskMedium: 'Medium risk',
    riskHigh: 'High risk',
    approve: 'Approve and execute',
    reject: 'Reject',
    working: 'Working…',
    proposedAction: 'Approved outcome',
    executionTools: 'Execution tools',
    evidence: 'Evidence',
    riskReason: 'Risk review',
    noProposals: 'No pending proposals. Dot is researching read-only sources in the background.',
    noSession: 'The Dot conversation is not created yet.',
    refreshed: 'Updated',
    approved: 'Approved. Dot is executing.',
    rejected: 'Rejected.',
    failed: 'Operation failed',
    approvedStatus: 'Approved',
    executingStatus: 'Executing',
    executedStatus: 'Executed',
    rejectedStatus: 'Rejected',
    failedStatus: 'Failed',
    pendingStatus: 'Pending',
    errorRead: 'Could not read DSH Dot state.',
    autoNote: 'Approval is user-only; Dot cannot approve itself.',
    executionResult: 'Execution result',
    tasks: 'Tracked tasks',
    emptyTasks: 'No tracked tasks yet.',
    schedules: 'Scheduled tasks',
    triggers: 'Event triggers',
    emptySchedules: 'No scheduled tasks yet.',
    emptyTriggers: 'No event triggers yet.',
    condition: 'Condition',
    detail: 'Schedule',
};
const OPEN_DOT_CSS = `
.dsh-dsh-dot-panel{box-sizing:border-box;width:100%;max-width:920px;margin:0 auto;padding:28px 28px 48px;color:var(--dsw-alias-label-primary);font-family:inherit}
.dsh-dsh-dot-header{display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap}
.dsh-dsh-dot-mark{display:grid;place-items:center;flex:none;width:44px;height:44px;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.dsh-dsh-dot-heading{min-width:0;flex:1}
.dsh-dsh-dot-title{margin:0;font-size:20px;line-height:28px;font-weight:650}
.dsh-dsh-dot-subtitle{margin:2px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsh-dsh-dot-head-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dsh-dsh-dot-btn{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);padding:5px 12px;font:inherit;font-size:12px;line-height:20px;cursor:pointer}
.dsh-dsh-dot-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
.dsh-dsh-dot-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsh-dsh-dot-btn.primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-weight:600}
.dsh-dsh-dot-btn.danger{color:var(--dsw-alias-state-error-primary)}
.dsh-dsh-dot-btn:disabled{opacity:.55;cursor:default}
.dsh-dsh-dot-status{display:inline-flex;align-items:center;gap:6px;border:.5px solid var(--dsw-alias-border-l1);border-radius:999px;padding:3px 9px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.dsh-dsh-dot-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.dsh-dsh-dot-dot.running{background:var(--dsw-alias-brand-primary)}
.dsh-dsh-dot-dot.error{background:var(--dsw-alias-state-error-primary)}
.dsh-dsh-dot-summary{display:flex;flex-wrap:wrap;gap:8px 18px;margin:18px 0 0;padding:12px 0;border-top:.5px solid var(--dsw-alias-border-l1);border-bottom:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px}
.dsh-dsh-dot-summary b{color:var(--dsw-alias-label-primary);font-weight:600}
.dsh-dsh-dot-section{margin-top:22px}
.dsh-dsh-dot-section-title{margin:0 0 10px;font-size:12px;line-height:18px;font-weight:650;letter-spacing:.02em;color:var(--dsw-alias-label-secondary);text-transform:uppercase}
.dsh-dsh-dot-card{border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px;margin-top:10px}
.dsh-dsh-dot-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-dsh-dot-risk{border:.5px solid currentColor;border-radius:999px;padding:0 7px;font-size:10px;line-height:17px;font-weight:600}
.dsh-dsh-dot-risk.high{color:var(--dsw-alias-state-error-primary)}
.dsh-dsh-dot-risk.medium{color:var(--dsw-alias-state-warn-primary)}
.dsh-dsh-dot-risk.low{color:var(--dsw-alias-state-success-primary)}
.dsh-dsh-dot-source{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px}
.dsh-dsh-dot-proposal-title{margin:7px 0 0;font-size:15px;line-height:22px;font-weight:600}
.dsh-dsh-dot-text{margin:5px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:19px;white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-dsh-dot-block{margin:10px 0 0;padding:9px 11px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:19px;white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-dsh-dot-block b{color:var(--dsw-alias-label-primary);font-weight:600}
.dsh-dsh-dot-tools{display:flex;gap:5px;flex-wrap:wrap;margin-top:6px}
.dsh-dsh-dot-chip{border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;padding:0 6px;font-size:10px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsh-dsh-dot-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
.dsh-dsh-dot-recent{display:flex;align-items:center;gap:9px;border-top:.5px solid var(--dsw-alias-border-l1);padding:8px 0;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.dsh-dsh-dot-recent:first-child{border-top:0}
.dsh-dsh-dot-recent-status{flex:none;font-weight:600}
.dsh-dsh-dot-recent-status.executed{color:var(--dsw-alias-state-success-primary)}
.dsh-dsh-dot-recent-status.rejected,.dsh-dsh-dot-recent-status.failed{color:var(--dsw-alias-state-error-primary)}
.dsh-dsh-dot-recent-status.executing{color:var(--dsw-alias-brand-primary)}
.dsh-dsh-dot-recent-text{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-dsh-dot-empty{border:.5px dashed var(--dsw-alias-border-l1);border-radius:12px;padding:18px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:19px;text-align:center}
.dsh-dsh-dot-error{margin-top:12px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.dsh-dsh-dot-flash{margin-top:12px;color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px}
.dsh-dsh-dot-note{margin-top:12px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px}
.dsh-dsh-dot-sources{display:flex;flex-direction:column;gap:4px;margin-top:6px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary)}
@media (prefers-reduced-motion: reduce){.dsh-dsh-dot-panel *{scroll-behavior:auto}}
`;
window.__ModuleLoader__.load({
    id: 'dsh-dot-plugin',
    factory(require) {
        const React = require('react');
        const h = React.createElement;
        return {
            name: 'dsh-dot-client',
            inject: ['slots', 'locale'],
            apply(ctx) {
                ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-dot: client locale');
                const bound = ctx.locale.bind(NS);
                const tr = (key, vars) => {
                    try {
                        return bound(key, vars);
                    }
                    catch {
                        return en[key] ?? key;
                    }
                };
                function DotIcon(props) {
                    const size = props.size ?? 20;
                    const color = props.active ? 'var(--dsw-alias-brand-primary)' : 'currentColor';
                    return h('svg', {
                        viewBox: '0 0 24 24',
                        width: size,
                        height: size,
                        'aria-hidden': true,
                        style: { display: 'block', color },
                    }, h('circle', {
                        cx: 12,
                        cy: 12,
                        r: 8.4,
                        fill: 'none',
                        stroke: 'currentColor',
                        'stroke-width': 1.5,
                        opacity: '.45',
                    }), h('circle', {
                        cx: 12,
                        cy: 12,
                        r: 4.7,
                        fill: 'none',
                        stroke: 'currentColor',
                        'stroke-width': 1.5,
                        opacity: '.75',
                    }), h('circle', { cx: 12, cy: 12, r: 1.9, fill: 'currentColor' }), h('circle', { cx: 19, cy: 5, r: 1.1, fill: 'currentColor' }));
                }
                function DotPanel(props) {
                    const t = props.t ?? tr;
                    const [state, setState] = React.useState(null);
                    const [busy, setBusy] = React.useState(null);
                    const [error, setError] = React.useState(null);
                    const [flash, setFlash] = React.useState(null);
                    const request = async (path, body) => {
                        const response = await fetch(path, {
                            method: body === undefined ? 'GET' : 'POST',
                            cache: 'no-store',
                            headers: body === undefined
                                ? { accept: 'application/json' }
                                : { 'content-type': 'application/json', 'x-dsh-dot': '1' },
                            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                        });
                        const payload = (await response.json().catch(() => null));
                        if (!response.ok) {
                            throw new Error(payload?.error || payload?.reason || `HTTP ${response.status}`);
                        }
                        return payload;
                    };
                    const refresh = async () => {
                        try {
                            const next = (await request('/dsh-dot/state'));
                            if (next?.ok) {
                                setState(next);
                                setError(null);
                            }
                        }
                        catch (cause) {
                            setError(`${t('errorRead')} ${cause?.message ?? ''}`.trim());
                        }
                    };
                    React.useEffect(() => {
                        let cancelled = false;
                        let timer;
                        const load = async () => {
                            try {
                                const next = (await request('/dsh-dot/state'));
                                if (!cancelled && next?.ok) {
                                    setState(next);
                                    setError(null);
                                }
                            }
                            catch (cause) {
                                if (!cancelled) {
                                    setError(`${t('errorRead')} ${cause?.message ?? ''}`.trim());
                                }
                            }
                            finally {
                                if (!cancelled)
                                    timer = setTimeout(load, 4_000);
                            }
                        };
                        void load();
                        const onVisible = () => {
                            if (document.visibilityState === 'visible' && !cancelled) {
                                if (timer)
                                    clearTimeout(timer);
                                void load();
                            }
                        };
                        document.addEventListener('visibilitychange', onVisible);
                        return () => {
                            cancelled = true;
                            if (timer)
                                clearTimeout(timer);
                            document.removeEventListener('visibilitychange', onVisible);
                        };
                    }, []);
                    const runNow = async () => {
                        setBusy('run');
                        setError(null);
                        setFlash(null);
                        try {
                            const result = await request('/dsh-dot/check', { reason: 'panel' });
                            if (result?.state)
                                setState(result.state);
                            setFlash(result?.started ? t('running') : String(result?.reason ?? ''));
                        }
                        catch (cause) {
                            setError(`${t('failed')}: ${cause?.message ?? String(cause)}`);
                        }
                        finally {
                            setBusy(null);
                        }
                    };
                    const decide = async (proposal, decision) => {
                        setBusy(proposal.id);
                        setError(null);
                        setFlash(null);
                        try {
                            const result = await request('/dsh-dot/decision', {
                                proposalId: proposal.id,
                                decision,
                            });
                            if (result?.state)
                                setState(result.state);
                            setFlash(decision === 'approve' ? t('approved') : t('rejected'));
                        }
                        catch (cause) {
                            setError(`${t('failed')}: ${cause?.message ?? String(cause)}`);
                        }
                        finally {
                            setBusy(null);
                        }
                    };
                    const openConversation = () => {
                        if (!state?.dotSessionId) {
                            setError(t('noSession'));
                            return;
                        }
                        try {
                            const uiWorkspace = ctx.get?.('uiWorkspace');
                            if (!uiWorkspace || typeof uiWorkspace.openSession !== 'function') {
                                throw new Error('uiWorkspace service is unavailable');
                            }
                            uiWorkspace.openSession(state.dotSessionId);
                        }
                        catch (cause) {
                            setError(`${t('failed')}: ${cause?.message ?? String(cause)}`);
                        }
                    };
                    const pending = (state?.proposals ?? []).filter((proposal) => proposal.status === 'pending');
                    const recent = (state?.proposals ?? []).filter((proposal) => proposal.status !== 'pending');
                    return h('div', { className: 'dsh-dsh-dot-panel', 'data-dsh-dot': 'panel' }, h('style', { key: 'style' }, OPEN_DOT_CSS), h('header', { className: 'dsh-dsh-dot-header' }, h('span', { className: 'dsh-dsh-dot-mark', 'aria-hidden': true }, h(DotIcon, { size: 28, active: true })), h('div', { className: 'dsh-dsh-dot-heading' }, h('h1', { className: 'dsh-dsh-dot-title' }, t('title')), h('p', { className: 'dsh-dsh-dot-subtitle' }, t('subtitle'))), h('div', { className: 'dsh-dsh-dot-head-actions' }, h('span', { className: 'dsh-dsh-dot-status' }, h('span', {
                        className: `dsh-dsh-dot-dot ${state?.dotStatus === 'running' ? 'running' : state?.dotStatus === 'error' ? 'error' : ''}`,
                    }), statusLabel(state?.dotStatus, t)), h('button', {
                        type: 'button',
                        className: 'dsh-dsh-dot-btn primary',
                        onClick: openConversation,
                        disabled: !state?.dotSessionId,
                    }, t('openConversation')), h('button', {
                        type: 'button',
                        className: 'dsh-dsh-dot-btn',
                        onClick: () => void runNow(),
                        disabled: busy !== null || state?.dotStatus === 'running',
                    }, busy === 'run' ? t('working') : t('runNow')))), state
                        ? h('div', { key: 'summary', className: 'dsh-dsh-dot-summary' }, h('span', null, h('b', null, pending.length), ` ${t('pending')}`), h('span', null, `${t('sources')}: ${state.sources.length}`), h('span', null, `${t('lastResearch')}: ${state.lastResearchCompletedAt
                            ? formatTime(state.lastResearchCompletedAt)
                            : state.lastResearchAt
                                ? t('running')
                                : t('never')}`), h('span', null, `${t('executionTools')}: ${state.executionTools.join(', ') || '—'}`))
                        : null, state && state.sources.length > 0
                        ? h('div', { key: 'sources', className: 'dsh-dsh-dot-sources' }, ...state.sources.map((source) => h('span', { key: source.id }, `${source.label} · ${source.kind}${source.path ? ` · ${source.path}` : source.url ? ` · ${source.url}` : ''}`)))
                        : state
                            ? h('p', { key: 'nosources', className: 'dsh-dsh-dot-text' }, t('noSources'))
                            : null, error ? h('div', { key: 'error', className: 'dsh-dsh-dot-error', role: 'alert' }, error) : null, flash ? h('div', { key: 'flash', className: 'dsh-dsh-dot-flash', role: 'status' }, flash) : null, h('section', { key: 'pending', className: 'dsh-dsh-dot-section' }, h('h2', { className: 'dsh-dsh-dot-section-title' }, `${t('pending')} · ${pending.length}`), ...pending.map((proposal) => renderProposal(proposal, busy, decide, t)), pending.length === 0
                        ? h('div', { className: 'dsh-dsh-dot-empty' }, t('noProposals'))
                        : null), recent.length > 0
                        ? h('section', { key: 'recent', className: 'dsh-dsh-dot-section' }, h('h2', { className: 'dsh-dsh-dot-section-title' }, t('recent')), h('div', { className: 'dsh-dsh-dot-card' }, ...recent.slice(0, 8).map((proposal) => h('div', { key: proposal.id, className: 'dsh-dsh-dot-recent' }, h('span', { className: `dsh-dsh-dot-recent-status ${proposal.status}` }, statusLabel(proposal.status, t)), h('span', { className: 'dsh-dsh-dot-recent-text' }, proposal.title), proposal.result
                            ? h('span', {
                                className: 'dsh-dsh-dot-recent-text',
                                title: proposal.result,
                            }, proposal.result.slice(0, 100))
                            : null))))
                        : null, state && state.tasks.length > 0
                        ? h('section', { key: 'tasks', className: 'dsh-dsh-dot-section' }, h('h2', { className: 'dsh-dsh-dot-section-title' }, t('tasks')), ...state.tasks.map((task) => h('div', { key: task.id, className: 'dsh-dsh-dot-card' }, h('div', { className: 'dsh-dsh-dot-proposal-title' }, task.goal), h('p', { className: 'dsh-dsh-dot-text' }, task.progress))))
                        : null, h('section', { key: 'schedules', className: 'dsh-dsh-dot-section' }, h('h2', { className: 'dsh-dsh-dot-section-title' }, t('schedules')), state && state.schedules.length > 0
                        ? h('div', { className: 'dsh-dsh-dot-card' }, ...state.schedules.map((schedule) => h('div', { key: schedule.id, className: 'dsh-dsh-dot-recent' }, h('span', { className: 'dsh-dsh-dot-recent-status' }, schedule.kind), h('span', { className: 'dsh-dsh-dot-recent-text' }, schedule.title), h('span', { className: 'dsh-dsh-dot-source' }, schedule.detail))))
                        : h('div', { className: 'dsh-dsh-dot-empty' }, t('emptySchedules'))), h('section', { key: 'triggers', className: 'dsh-dsh-dot-section' }, h('h2', { className: 'dsh-dsh-dot-section-title' }, t('triggers')), state && state.triggers.length > 0
                        ? h('div', { className: 'dsh-dsh-dot-card' }, ...state.triggers.map((trigger) => h('div', { key: trigger.id, className: 'dsh-dsh-dot-recent' }, h('span', { className: 'dsh-dsh-dot-recent-status' }, trigger.source), h('span', { className: 'dsh-dsh-dot-recent-text' }, trigger.instruction), h('span', { className: 'dsh-dsh-dot-source' }, `${t('condition')}: ${trigger.condition}`))))
                        : h('div', { className: 'dsh-dsh-dot-empty' }, t('emptyTriggers'))), h('p', { key: 'note', className: 'dsh-dsh-dot-note' }, t('autoNote')));
                }
                function renderProposal(proposal, busy, decide, t) {
                    const isBusy = busy === proposal.id;
                    return h('article', { key: proposal.id, className: 'dsh-dsh-dot-card' }, h('div', { className: 'dsh-dsh-dot-row' }, h('span', { className: `dsh-dsh-dot-risk ${proposal.risk}` }, riskLabel(proposal.risk, t)), h('span', { className: 'dsh-dsh-dot-source' }, proposal.source), h('span', { className: 'dsh-dsh-dot-source' }, proposal.actionType)), h('h3', { className: 'dsh-dsh-dot-proposal-title' }, proposal.title), h('p', { className: 'dsh-dsh-dot-text' }, proposal.description), h('p', { className: 'dsh-dsh-dot-block' }, h('b', null, `${t('proposedAction')}: `), proposal.proposedAction), proposal.evidence
                        ? h('p', { className: 'dsh-dsh-dot-block' }, h('b', null, `${t('evidence')}: `), proposal.evidence)
                        : null, h('p', { className: 'dsh-dsh-dot-text' }, h('b', null, `${t('riskReason')}: `), proposal.riskReason), proposal.executionTools.length > 0
                        ? h('div', { className: 'dsh-dsh-dot-tools' }, ...proposal.executionTools.map((tool) => h('span', { key: tool, className: 'dsh-dsh-dot-chip' }, tool)))
                        : null, h('div', { className: 'dsh-dsh-dot-actions' }, h('button', {
                        type: 'button',
                        className: 'dsh-dsh-dot-btn',
                        disabled: isBusy,
                        onClick: () => void decide(proposal, 'reject'),
                    }, t('reject')), h('button', {
                        type: 'button',
                        className: 'dsh-dsh-dot-btn primary',
                        disabled: isBusy,
                        onClick: () => void decide(proposal, 'approve'),
                    }, isBusy ? t('working') : t('approve'))));
                }
                function statusLabel(status, t) {
                    if (status === 'running')
                        return t('running');
                    if (status === 'starting')
                        return t('starting');
                    if (status === 'error')
                        return t('error');
                    if (status === 'executed')
                        return t('executedStatus');
                    if (status === 'executing' || status === 'approved')
                        return t('executingStatus');
                    if (status === 'rejected')
                        return t('rejectedStatus');
                    if (status === 'failed')
                        return t('failedStatus');
                    if (status === 'pending')
                        return t('pendingStatus');
                    return t('idle');
                }
                function riskLabel(risk, t) {
                    if (risk === 'high')
                        return t('riskHigh');
                    if (risk === 'medium')
                        return t('riskMedium');
                    return t('riskLow');
                }
                function formatTime(at) {
                    try {
                        return new Date(at).toLocaleString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                        });
                    }
                    catch {
                        return '';
                    }
                }
                ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
                    name: 'sidebar.panellist',
                    id: 'dsh-dot-plugin',
                    order: 20,
                    label: () => tr('title'),
                }, DotIcon));
                ctx.slots.inject('main', () => ctx.slots.register({
                    name: 'main',
                    key: 'dsh-dot-plugin',
                }, DotPanel));
            },
        };
    },
});
