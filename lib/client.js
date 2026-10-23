"use strict";
/**
 * DSH Dot Client panel.
 *
 * A dedicated main panel plus a sidebar icon. The panel is the user-only
 * control surface: it reads proposals and submits approve/reject decisions.
 * The Dot Agent has no Tool that can call these endpoints.
 */
const NS = 'dsh-dot';
const TAB_KIND = 'dsh-dot';
const TAB_ID = 'dsh-dot-plugin/rail';
const zh = {
    title: 'DSH Dot',
    dotShort: 'Dot',
    openPanel: '完整面板',
    railPending: '待批准',
    railClear: '当前没有待批准提案。',
    railRecent: '最近输出',
    railHint: '批准仅限用户操作；Dot 不能批准自己。',
    railLoading: '正在加载 DSH Dot…',
    railSources: '数据源',
    focus: '聚焦',
    focused: '已聚焦',
    workers: 'Workers',
    taskDetail: '当前任务',
    artifacts: '产物',
    activity: '活动',
    noWorkers: '当前没有 worker。',
    noArtifacts: '当前没有产物。',
    railNoSession: 'Dot 会话尚未创建。',
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
    waitingForDeps: '等待依赖',
    condition: '条件',
    detail: '计划',
};
const en = {
    title: 'DSH Dot',
    dotShort: 'Dot',
    openPanel: 'Full panel',
    railPending: 'Pending',
    railClear: 'No pending proposals.',
    railRecent: 'Recent outputs',
    railHint: 'Approvals are user-only; Dot cannot approve itself.',
    railLoading: 'Loading DSH Dot…',
    railSources: 'Sources',
    focus: 'Focus',
    focused: 'Focused',
    workers: 'Workers',
    taskDetail: 'Focused task',
    artifacts: 'Outputs',
    activity: 'Activity',
    noWorkers: 'No workers yet.',
    noArtifacts: 'No outputs yet.',
    railNoSession: 'The Dot conversation is not created yet.',
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
    waitingForDeps: 'Waiting for',
    condition: 'Condition',
    detail: 'Schedule',
};
const OPEN_DOT_CSS = `
.dsh-dot-panel{box-sizing:border-box;width:100%;max-width:920px;margin:0 auto;padding:28px 28px 48px;color:var(--dsw-alias-label-primary);font-family:inherit}
.dsh-dot-header{display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap}
.dsh-dot-mark{display:grid;place-items:center;flex:none;width:44px;height:44px;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.dsh-dot-heading{min-width:0;flex:1}
.dsh-dot-title{margin:0;font-size:20px;line-height:28px;font-weight:650}
.dsh-dot-subtitle{margin:2px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsh-dot-head-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dsh-dot-btn{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);padding:5px 12px;font:inherit;font-size:12px;line-height:20px;cursor:pointer}
.dsh-dot-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
.dsh-dot-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsh-dot-btn.primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-weight:600}
.dsh-dot-btn.danger{color:var(--dsw-alias-state-error-primary)}
.dsh-dot-btn:disabled{opacity:.55;cursor:default}
.dsh-dot-status{display:inline-flex;align-items:center;gap:6px;border:.5px solid var(--dsw-alias-border-l1);border-radius:999px;padding:3px 9px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.dsh-dot-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.dsh-dot-dot.running{background:var(--dsw-alias-brand-primary)}
.dsh-dot-dot.error{background:var(--dsw-alias-state-error-primary)}
.dsh-dot-summary{display:flex;flex-wrap:wrap;gap:8px 18px;margin:18px 0 0;padding:12px 0;border-top:.5px solid var(--dsw-alias-border-l1);border-bottom:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px}
.dsh-dot-summary b{color:var(--dsw-alias-label-primary);font-weight:600}
.dsh-dot-section{margin-top:22px}
.dsh-dot-section-title{margin:0 0 10px;font-size:12px;line-height:18px;font-weight:650;letter-spacing:.02em;color:var(--dsw-alias-label-secondary);text-transform:uppercase}
.dsh-dot-card{border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px;margin-top:10px}
.dsh-dot-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-dot-risk{border:.5px solid currentColor;border-radius:999px;padding:0 7px;font-size:10px;line-height:17px;font-weight:600}
.dsh-dot-risk.high{color:var(--dsw-alias-state-error-primary)}
.dsh-dot-risk.medium{color:var(--dsw-alias-state-warn-primary)}
.dsh-dot-risk.low{color:var(--dsw-alias-state-success-primary)}
.dsh-dot-source{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px}
.dsh-dot-proposal-title{margin:7px 0 0;font-size:15px;line-height:22px;font-weight:600}
.dsh-dot-text{margin:5px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:19px;white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-dot-block{margin:10px 0 0;padding:9px 11px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:19px;white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-dot-block b{color:var(--dsw-alias-label-primary);font-weight:600}
.dsh-dot-tools{display:flex;gap:5px;flex-wrap:wrap;margin-top:6px}
.dsh-dot-chip{border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;padding:0 6px;font-size:10px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsh-dot-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
.dsh-dot-recent{display:flex;align-items:center;gap:9px;border-top:.5px solid var(--dsw-alias-border-l1);padding:8px 0;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.dsh-dot-recent:first-child{border-top:0}
.dsh-dot-recent-status{flex:none;font-weight:600}
.dsh-dot-recent-status.executed{color:var(--dsw-alias-state-success-primary)}
.dsh-dot-recent-status.rejected,.dsh-dot-recent-status.failed{color:var(--dsw-alias-state-error-primary)}
.dsh-dot-recent-status.executing{color:var(--dsw-alias-brand-primary)}
.dsh-dot-recent-text{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-dot-empty{border:.5px dashed var(--dsw-alias-border-l1);border-radius:12px;padding:18px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:19px;text-align:center}
.dsh-dot-error{margin-top:12px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.dsh-dot-flash{margin-top:12px;color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px}
.dsh-dot-note{margin-top:12px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px}
.dsh-dot-sources{display:flex;flex-direction:column;gap:4px;margin-top:6px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary)}
@media (prefers-reduced-motion: reduce){.dsh-dot-panel *{scroll-behavior:auto}}
`;
const RAIL_CSS = `

.dsh-dot-task-status{display:inline-flex;align-items:center;border:.5px solid var(--dsw-alias-border-l1);border-radius:999px;padding:0 7px;font-size:10px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsh-dot-task-status.running{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dsh-dot-task-status.coordinating{color:var(--dsw-alias-brand-primary)}
.dsh-dot-task-status.waiting_user{color:var(--dsw-alias-state-warning-primary)}
.dsh-dot-task-status.blocked,.dsh-dot-task-status.failed{color:var(--dsw-alias-state-error-primary)}
.dsh-dot-task-status.done{color:var(--dsw-alias-state-success-primary)}
.dsh-dot-task-card[data-status="done"]{opacity:.78}
.dsh-dot-task-card .dsh-dot-actions{justify-content:flex-start}
.dsh-dot-rail{max-width:none;padding:12px 12px 28px}
.dsh-dot-rail .dsh-dot-header{gap:10px;align-items:center}
.dsh-dot-rail .dsh-dot-mark{width:34px;height:34px;border-radius:9px}
.dsh-dot-rail .dsh-dot-title{font-size:16px;line-height:22px}
.dsh-dot-rail .dsh-dot-subtitle{font-size:11px;line-height:16px}
.dsh-dot-rail .dsh-dot-head-actions{margin-top:10px}
.dsh-dot-rail .dsh-dot-btn{padding:4px 9px;font-size:11px;line-height:18px}
.dsh-dot-rail .dsh-dot-section{margin-top:14px}
.dsh-dot-rail .dsh-dot-section-title{font-size:10px;margin-bottom:6px}
.dsh-dot-rail .dsh-dot-card{padding:10px 11px;border-radius:10px;margin-top:7px}
.dsh-dot-rail .dsh-dot-proposal-title{font-size:13px;line-height:19px;margin-top:5px}
.dsh-dot-rail .dsh-dot-text{font-size:11px;line-height:17px}
.dsh-dot-rail .dsh-dot-block{padding:7px 8px;font-size:11px;line-height:17px;margin-top:7px}
.dsh-dot-rail .dsh-dot-actions{margin-top:8px}
.dsh-dot-rail .dsh-dot-empty{padding:12px;font-size:11px;line-height:17px}
.dsh-dot-rail .dsh-dot-summary{gap:5px 12px;margin-top:12px;padding:8px 0;font-size:10px}
.dsh-dot-rail .dsh-dot-sources{font-size:10px;line-height:16px}
.dsh-dot-rail .dsh-dot-note{font-size:10px;line-height:15px;margin-top:10px}
.dsh-dot-header-action{border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);display:inline-flex;align-items:center;gap:5px;padding:2px 8px;font:inherit;font-size:11px;line-height:19px;cursor:pointer}
.dsh-dot-header-action:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dsh-dot-header-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsh-dot-footer-action{border:0;background:transparent;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:9px;width:100%;padding:8px 10px;border-radius:8px;font:inherit;font-size:12px;line-height:20px;cursor:pointer;text-align:left}
.dsh-dot-footer-action:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-dot-footer-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsh-dot-tab-title{display:inline-flex;align-items:center;gap:5px;min-width:0;color:var(--dsw-alias-label-primary)}
.dsh-dot-tab-title span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`;
const CHAT_CSS = `
.dsh-dot-gateway{box-sizing:border-box;min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;text-align:center;padding:40px}
.dsh-dot-gateway-mark{display:grid;place-items:center;width:52px;height:52px;border:.5px solid var(--dsw-alias-border-l1);border-radius:16px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-brand-primary)}
.dsh-dot-presence-wrap{display:inline-flex;align-items:center}
.dsh-dot-presence{display:inline-flex;align-items:center;gap:6px;border:.5px solid var(--dsw-alias-border-l1);border-radius:999px;padding:2px 8px 2px 5px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px}
.dsh-dot-presence-dot{width:10px;height:10px;border-radius:50%;background:var(--dsw-alias-brand-primary);box-shadow:0 0 0 0 color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, transparent)}
.dsh-dot-presence.busy .dsh-dot-presence-dot{animation:dsh-dot-breathe 1.5s ease-in-out infinite}
.dsh-dot-presence.idle .dsh-dot-presence-dot{opacity:.55;transform:scale(.8)}
@keyframes dsh-dot-breathe{0%,100%{transform:scale(.75);opacity:.55}50%{transform:scale(1.15);opacity:1}}
@media (prefers-reduced-motion:reduce){.dsh-dot-presence.busy .dsh-dot-presence-dot{animation:none;transform:scale(1)}}
`;
const DOT_CHAT_CSS = `
.dsh-dot-chat{box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;
  --dot-bg:var(--dsw-alias-bg-base);--dot-surface:var(--dsw-alias-bg-layer-1);--dot-surface-2:var(--dsw-alias-bg-layer-2);
  --dot-border:var(--dsw-alias-border-l1);--dot-border-strong:var(--dsw-alias-border-l2);
  --dot-text:var(--dsw-alias-label-primary);--dot-muted:var(--dsw-alias-label-secondary);
  --dot-accent:#3b6cff;--dot-user:#3b5bff;--dot-on-accent:#fff;
  --dot-gutter:18px;--dot-column:680px;--dot-radius:14px;
  --dot-icon:16px;--dot-hit:32px;--dot-icon-gap:8px;--dot-icon-inset:8px;
  background:var(--dot-bg);color:var(--dot-text);font:inherit}
.dsh-dot-chat-head{display:flex;align-items:center;gap:10px;padding:14px var(--dot-gutter);border-bottom:1px solid var(--dot-border);background:var(--dot-bg)}
.dsh-dot-chat-mark{display:grid;place-items:center;width:34px;height:34px;border:1px solid var(--dot-border);border-radius:50%;color:var(--dot-accent);flex:none;background:var(--dot-surface)}
.dsh-dot-chat-title{min-width:0;flex:1}
.dsh-dot-chat-title h1{margin:0;font-size:15px;line-height:21px;font-weight:650;color:var(--dot-text)}
.dsh-dot-chat-title p{margin:1px 0 0;color:var(--dot-muted);font-size:11px;line-height:16px}
.dsh-dot-chat-thinking{display:flex;align-items:center;justify-content:flex-start;width:22px;height:22px;margin:0;padding:0;border:0;background:transparent;align-self:flex-start;flex:none}
.dsh-dot-chat-thinking-dot{display:block;flex:none;width:12px;height:12px;color:#7fb6ff;overflow:visible;transform-origin:50% 50%;animation:dsh-dot-breathe 1.45s ease-in-out infinite}
.dsh-dot-chat-body{position:relative;flex:1;min-height:0;display:flex}
.dsh-dot-chat-scroll{flex:1;min-height:0;overflow:auto;overflow-x:hidden;padding:22px var(--dot-gutter) 12px}
.dsh-dot-chat-content{display:flex;flex-direction:column;gap:12px;min-height:100%;min-width:0;box-sizing:border-box}
.dsh-dot-chat-empty{margin:auto;max-width:420px;text-align:center;color:var(--dot-muted);font-size:13px;line-height:21px;white-space:pre-line}
.dsh-dot-chat-bubbles{display:flex;flex-direction:column;gap:4px;max-width:min(var(--dot-column),86%);align-self:flex-start;min-width:0}
.dsh-dot-chat-bubbles .dsh-dot-chat-msg{max-width:100%}
.dsh-dot-chat-msg{position:relative;max-width:min(var(--dot-column),86%);border-radius:18px;padding:8px 13px;font-size:13px;line-height:21px;white-space:pre-wrap;overflow-wrap:anywhere;box-sizing:border-box}
.dsh-dot-chat-msg.assistant.tail{border-bottom-left-radius:8px}
.dsh-dot-chat-msg.assistant.tail::after{content:'';position:absolute;left:-5px;bottom:0;width:13px;height:15px;background:var(--dot-surface);border:0;clip-path:polygon(0 15px,6px 15px,13px 4px,11.2px 2.2px,6.6px 9.4px,0 12.2px);pointer-events:none;filter:drop-shadow(-0.4px 0.4px 0 color-mix(in srgb,var(--dot-text) 17%,transparent))}

.dsh-dot-chat-msg.user.tail{border-bottom-right-radius:8px}
.dsh-dot-chat-msg.user.tail::after{content:'';position:absolute;right:-5px;bottom:0;width:13px;height:15px;background:var(--dot-user);border:0;clip-path:polygon(13px 15px,7px 15px,0 4px,1.8px 2.2px,6.4px 9.4px,13px 12.2px);pointer-events:none}
.dsh-dot-chat-msg.assistant{background:color-mix(in srgb,var(--dot-text) 8%,var(--dot-bg));border:1px solid color-mix(in srgb,var(--dot-text) 17%,transparent);color:var(--dot-text)}
.dsh-dot-chat-msg.user{align-self:flex-end;background:var(--dot-user);color:var(--dot-on-accent);border:1px solid transparent}
.dsh-dot-chat-quote{display:flex;align-items:baseline;gap:6px;width:100%;min-width:0;margin:0 0 3px;padding:4px 9px;border:0;border-left:2px solid var(--dot-accent);border-radius:0 7px 7px 0;background:color-mix(in srgb,var(--dot-text) 8%,transparent);color:var(--dot-muted);font:inherit;font-size:11px;line-height:17px;text-align:left;cursor:pointer;overflow:hidden}
.dsh-dot-chat-quote:hover{background:color-mix(in srgb,var(--dot-text) 13%,transparent);color:var(--dot-text)}
.dsh-dot-chat-quote-role{flex:none;font-weight:600;color:var(--dot-accent)}
.dsh-dot-chat-quote-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-dot-chat-bubbles.dsh-dot-chat-target .dsh-dot-chat-msg,.dsh-dot-chat-msg.user.dsh-dot-chat-target{animation:dsh-dot-target 1.2s ease-out}
.dsh-dot-chat-segment{animation:dsh-dot-bubble-in .18s ease-out both}
.dsh-dot-chat-approval{align-self:stretch;max-width:var(--dot-column);box-sizing:border-box;overflow-wrap:anywhere;border:1px solid var(--dot-border-strong);border-radius:var(--dot-radius);background:var(--dot-surface);padding:12px 14px;font-size:12px;line-height:19px;color:var(--dot-text)}
.dsh-dot-chat-approval-title{font-weight:600;margin-bottom:4px}
.dsh-dot-chat-approval-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:9px}
.dsh-dot-chat-btn{border:1px solid var(--dot-border-strong);border-radius:8px;background:transparent;color:var(--dot-text);padding:4px 11px;font:inherit;font-size:12px;line-height:20px;cursor:pointer}
.dsh-dot-chat-btn.primary{background:var(--dot-accent);border-color:var(--dot-accent);color:var(--dot-on-accent)}
.dsh-dot-chat-btn:disabled{opacity:.5;cursor:default}
.dsh-dot-chat-compose{position:absolute;left:0;right:0;bottom:0;z-index:3;box-sizing:border-box;padding:10px var(--dot-gutter) calc(18px + env(safe-area-inset-bottom));background:transparent;pointer-events:none}
.dsh-dot-chat-composer{pointer-events:auto;box-sizing:border-box;width:100%;min-width:0;display:flex;flex-direction:column;gap:6px;padding:14px 16px 12px;border:1px solid var(--dot-border);border-radius:22px;background:color-mix(in srgb,var(--dot-bg) 94%,var(--dot-text));box-shadow:0 2px 6px rgba(0,0,0,.10),0 18px 40px -24px rgba(0,0,0,.45);backdrop-filter:blur(10px);transition:border-color .15s ease,box-shadow .15s ease}
.dsh-dot-chat-composer:focus-within{border-color:var(--dot-border-strong);box-shadow:0 2px 6px rgba(0,0,0,.12),0 18px 40px -22px rgba(0,0,0,.5)}
.dsh-dot-chat-input-wrap{display:flex;align-items:flex-end;gap:var(--dot-icon-gap);box-sizing:border-box;width:100%;min-width:0;padding:0;border:0;border-radius:0;background:transparent}
.dsh-dot-chat-input{display:block;flex:1;align-self:flex-start;min-width:0;box-sizing:border-box;margin:0;padding:0 2px;min-height:44px;max-height:160px;resize:none;border:0;outline:0;background:transparent;color:var(--dot-text);font:inherit;font-size:13.5px;line-height:22px;overflow-y:auto}
.dsh-dot-chat-input::placeholder{color:var(--dot-muted);opacity:.72}
.dsh-dot-chat-icon{display:block;flex:none;width:var(--dot-icon);height:var(--dot-icon)}
.dsh-dot-chat-image-btn,.dsh-dot-chat-send{box-sizing:border-box;flex:none;display:grid;place-items:center;width:var(--dot-hit);height:var(--dot-hit);min-width:var(--dot-hit);min-height:var(--dot-hit);padding:0;border-radius:50%;cursor:pointer;line-height:0}
.dsh-dot-chat-image-btn{border:0;background:transparent;color:var(--dot-muted)}
.dsh-dot-chat-image-btn:hover:not(:disabled){background:color-mix(in srgb,var(--dot-text) 8%,transparent);color:var(--dot-text)}
.dsh-dot-chat-image-btn:disabled{opacity:.4;cursor:default}
.dsh-dot-chat-image-btn:focus-visible,.dsh-dot-chat-send:focus-visible{outline:2px solid var(--dot-accent);outline-offset:2px}
.dsh-dot-chat-previews{display:flex;gap:8px;flex-wrap:wrap;padding:0}
.dsh-dot-chat-preview{position:relative;width:64px;height:64px;border:1px solid var(--dot-border-strong);border-radius:10px;overflow:hidden;background:var(--dot-surface)}
.dsh-dot-chat-preview img{width:100%;height:100%;object-fit:cover;display:block}
.dsh-dot-chat-preview button{position:absolute;top:2px;right:2px;width:18px;height:18px;border:0;border-radius:50%;background:rgba(0,0,0,.6);color:#fff;font-size:12px;line-height:18px;cursor:pointer;padding:0}
.dsh-dot-chat-msg.user .dsh-dot-chat-images{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px}
.dsh-dot-chat-msg.user .dsh-dot-chat-images img{max-width:220px;max-height:180px;border-radius:8px;display:block;object-fit:contain;background:rgba(0,0,0,.04)}
.dsh-dot-chat-send{width:34px;height:34px;min-width:34px;min-height:34px;border:0;background:color-mix(in srgb,var(--dot-accent) 55%,var(--dot-bg));color:var(--dot-on-accent);transition:background .15s ease}
.dsh-dot-chat-send:enabled{background:var(--dot-accent)}
.dsh-dot-chat-send:enabled:hover{filter:brightness(1.08)}
.dsh-dot-chat-actions{display:flex;align-items:center;gap:4px;flex:none;padding-bottom:3px}
.dsh-dot-chat-send:disabled{opacity:.4;cursor:default}
.dsh-dot-chat-error{color:var(--dsw-alias-state-error-primary);font-size:11px;margin-top:6px}
@keyframes dsh-dot-breathe{0%,100%{transform:scale(.72);opacity:.55}50%{transform:scale(1.45);opacity:1}}
@keyframes dsh-dot-bubble-in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:translateY(0)}}
@keyframes dsh-dot-target{0%{box-shadow:0 0 0 2px var(--dot-accent)}70%{box-shadow:0 0 0 2px color-mix(in srgb,var(--dot-accent) 35%,transparent)}100%{box-shadow:0 0 0 0 transparent}}
@media (max-width:480px){
  .dsh-dot-chat{--dot-gutter:12px;--dot-icon-inset:10px;--dot-icon-gap:6px}
  .dsh-dot-chat-head{padding:12px var(--dot-gutter)}
  .dsh-dot-chat-scroll{padding:16px var(--dot-gutter) 10px}
  .dsh-dot-chat-compose{padding:8px var(--dot-gutter) calc(14px + env(safe-area-inset-bottom))}
  .dsh-dot-chat-composer{padding:12px 13px 10px;border-radius:20px}
  .dsh-dot-chat-bubbles,.dsh-dot-chat-msg{max-width:min(var(--dot-column),92%)}
}
@media (prefers-reduced-motion:reduce){.dsh-dot-chat-segment,.dsh-dot-chat-msg.user.dsh-dot-chat-target,.dsh-dot-chat-bubbles.dsh-dot-chat-target .dsh-dot-chat-msg{animation:none}}
`;
window.__ModuleLoader__.load({
    id: 'dsh-dot-plugin',
    factory(require) {
        const React = require('react');
        const h = React.createElement;
        return {
            name: 'dsh-dot-client',
            inject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'],
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
                const railRequest = async (path, body) => {
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
                                    timer = setTimeout(load, 2_000);
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
                    return h('div', { className: 'dsh-dot-panel', 'data-dsh-dot': 'panel' }, h('style', { key: 'style' }, OPEN_DOT_CSS), h('header', { className: 'dsh-dot-header' }, h('span', { className: 'dsh-dot-mark', 'aria-hidden': true }, h(DotIcon, { size: 28, active: true })), h('div', { className: 'dsh-dot-heading' }, h('h1', { className: 'dsh-dot-title' }, t('title')), h('p', { className: 'dsh-dot-subtitle' }, t('subtitle'))), h('div', { className: 'dsh-dot-head-actions' }, h('span', { className: 'dsh-dot-status' }, h('span', {
                        className: `dsh-dot-dot ${state?.dotStatus === 'running' ? 'running' : state?.dotStatus === 'error' ? 'error' : ''}`,
                    }), statusLabel(state?.dotStatus, t)), h('button', {
                        type: 'button',
                        className: 'dsh-dot-btn primary',
                        onClick: openConversation,
                        disabled: !state?.dotSessionId,
                    }, t('openConversation')), h('button', {
                        type: 'button',
                        className: 'dsh-dot-btn',
                        onClick: () => void runNow(),
                        disabled: busy !== null || state?.dotStatus === 'running',
                    }, busy === 'run' ? t('working') : t('runNow')))), state
                        ? h('div', { key: 'summary', className: 'dsh-dot-summary' }, h('span', null, h('b', null, pending.length), ` ${t('pending')}`), h('span', null, `${t('sources')}: ${state.sources.length}`), h('span', null, `${t('lastResearch')}: ${state.lastResearchCompletedAt
                            ? formatTime(state.lastResearchCompletedAt)
                            : state.lastResearchAt
                                ? t('running')
                                : t('never')}`), h('span', null, `${t('executionTools')}: ${state.executionTools.join(', ') || '—'}`))
                        : null, state && state.sources.length > 0
                        ? h('div', { key: 'sources', className: 'dsh-dot-sources' }, ...state.sources.map((source) => h('span', { key: source.id }, `${source.label} · ${source.kind}${source.path ? ` · ${source.path}` : source.url ? ` · ${source.url}` : ''}`)))
                        : state
                            ? h('p', { key: 'nosources', className: 'dsh-dot-text' }, t('noSources'))
                            : null, error ? h('div', { key: 'error', className: 'dsh-dot-error', role: 'alert' }, error) : null, flash ? h('div', { key: 'flash', className: 'dsh-dot-flash', role: 'status' }, flash) : null, h('section', { key: 'pending', className: 'dsh-dot-section' }, h('h2', { className: 'dsh-dot-section-title' }, `${t('pending')} · ${pending.length}`), ...pending.map((proposal) => renderProposal(proposal, busy, decide, t)), pending.length === 0
                        ? h('div', { className: 'dsh-dot-empty' }, t('noProposals'))
                        : null), recent.length > 0
                        ? h('section', { key: 'recent', className: 'dsh-dot-section' }, h('h2', { className: 'dsh-dot-section-title' }, t('recent')), h('div', { className: 'dsh-dot-card' }, ...recent.slice(0, 8).map((proposal) => h('div', { key: proposal.id, className: 'dsh-dot-recent' }, h('span', { className: `dsh-dot-recent-status ${proposal.status}` }, statusLabel(proposal.status, t)), h('span', { className: 'dsh-dot-recent-text' }, proposal.title), proposal.result
                            ? h('span', {
                                className: 'dsh-dot-recent-text',
                                title: proposal.result,
                            }, proposal.result.slice(0, 100))
                            : null))))
                        : null, state && state.tasks.length > 0
                        ? h('section', { key: 'tasks', className: 'dsh-dot-section' }, h('h2', { className: 'dsh-dot-section-title' }, t('tasks')), ...state.tasks.map((task) => h('div', { key: task.id, className: 'dsh-dot-card dsh-dot-task-card', 'data-status': task.status }, h('div', { className: 'dsh-dot-row' }, h('span', { className: `dsh-dot-task-status ${task.status}` }, task.status), task.priority ? h('span', { className: 'dsh-dot-source' }, task.priority) : null, task.workerId ? h('span', { className: 'dsh-dot-source' }, task.workerId.slice(0, 14)) : null), h('div', { className: 'dsh-dot-proposal-title' }, task.title ?? task.goal ?? 'Untitled task'), h('p', { className: 'dsh-dot-text' }, task.plan ?? task.progress ?? ''), task.nextAction ? h('p', { className: 'dsh-dot-note' }, task.nextAction) : null, task.waitingFor ? h('p', { className: 'dsh-dot-note' }, `Waiting: ${task.waitingFor}`) : null, task.waitingOnTitles && task.waitingOnTitles.length > 0
                            ? h('p', { className: 'dsh-dot-note' }, `${t('waitingForDeps')}: ${task.waitingOnTitles.join(', ')}`)
                            : null, task.blockedReason ? h('p', { className: 'dsh-dot-error' }, task.blockedReason) : null)))
                        : null, h('section', { key: 'schedules', className: 'dsh-dot-section' }, h('h2', { className: 'dsh-dot-section-title' }, t('schedules')), state && state.schedules.length > 0
                        ? h('div', { className: 'dsh-dot-card' }, ...state.schedules.map((schedule) => h('div', { key: schedule.id, className: 'dsh-dot-recent' }, h('span', { className: 'dsh-dot-recent-status' }, schedule.kind), h('span', { className: 'dsh-dot-recent-text' }, schedule.title), h('span', { className: 'dsh-dot-source' }, schedule.detail))))
                        : h('div', { className: 'dsh-dot-empty' }, t('emptySchedules'))), h('section', { key: 'triggers', className: 'dsh-dot-section' }, h('h2', { className: 'dsh-dot-section-title' }, t('triggers')), state && state.triggers.length > 0
                        ? h('div', { className: 'dsh-dot-card' }, ...state.triggers.map((trigger) => h('div', { key: trigger.id, className: 'dsh-dot-recent' }, h('span', { className: 'dsh-dot-recent-status' }, trigger.source), h('span', { className: 'dsh-dot-recent-text' }, trigger.instruction), h('span', { className: 'dsh-dot-source' }, `${t('condition')}: ${trigger.condition}`))))
                        : h('div', { className: 'dsh-dot-empty' }, t('emptyTriggers'))), h('p', { key: 'note', className: 'dsh-dot-note' }, t('autoNote')));
                }
                function renderProposal(proposal, busy, decide, t) {
                    const isBusy = busy === proposal.id;
                    return h('article', { key: proposal.id, className: 'dsh-dot-card' }, h('div', { className: 'dsh-dot-row' }, h('span', { className: `dsh-dot-risk ${proposal.risk}` }, riskLabel(proposal.risk, t)), h('span', { className: 'dsh-dot-source' }, proposal.source), h('span', { className: 'dsh-dot-source' }, proposal.actionType)), h('h3', { className: 'dsh-dot-proposal-title' }, proposal.title), h('p', { className: 'dsh-dot-text' }, proposal.description), h('p', { className: 'dsh-dot-block' }, h('b', null, `${t('proposedAction')}: `), proposal.proposedAction), proposal.evidence
                        ? h('p', { className: 'dsh-dot-block' }, h('b', null, `${t('evidence')}: `), proposal.evidence)
                        : null, h('p', { className: 'dsh-dot-text' }, h('b', null, `${t('riskReason')}: `), proposal.riskReason), proposal.executionTools.length > 0
                        ? h('div', { className: 'dsh-dot-tools' }, ...proposal.executionTools.map((tool) => h('span', { key: tool, className: 'dsh-dot-chip' }, tool)))
                        : null, h('div', { className: 'dsh-dot-actions' }, h('button', {
                        type: 'button',
                        className: 'dsh-dot-btn',
                        disabled: isBusy,
                        onClick: () => void decide(proposal, 'reject'),
                    }, t('reject')), h('button', {
                        type: 'button',
                        className: 'dsh-dot-btn primary',
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
                function DotRail(props) {
                    const t = props.t ?? tr;
                    const [state, setState] = React.useState(null);
                    const [busy, setBusy] = React.useState(null);
                    const [error, setError] = React.useState(null);
                    const [flash, setFlash] = React.useState(null);
                    React.useEffect(() => {
                        let cancelled = false;
                        let timer;
                        const load = async () => {
                            try {
                                const next = (await railRequest('/dsh-dot/state'));
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
                                    timer = setTimeout(load, 2_000);
                            }
                        };
                        void load();
                        return () => {
                            cancelled = true;
                            if (timer)
                                clearTimeout(timer);
                        };
                    }, []);
                    const openConversation = () => {
                        const uiWorkspace = ctx.get?.('uiWorkspace');
                        if (uiWorkspace?.openSession && state?.dotSessionId) {
                            uiWorkspace.openSession(state.dotSessionId);
                        }
                        else {
                            setError(t('railNoSession'));
                        }
                    };
                    const openPanel = () => {
                        try {
                            ctx.get?.('layout')?.selectPanel?.('dsh-dot-plugin');
                        }
                        catch (cause) {
                            setError(`${t('failed')}: ${cause?.message ?? String(cause)}`);
                        }
                    };
                    const runNow = async () => {
                        setBusy('run');
                        setError(null);
                        setFlash(null);
                        try {
                            const result = await railRequest('/dsh-dot/check', { reason: 'rail' });
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
                            const result = await railRequest('/dsh-dot/decision', {
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
                    const focusTask = async (taskId) => {
                        setBusy(`focus:${taskId}`);
                        setError(null);
                        setFlash(null);
                        try {
                            const result = await railRequest('/dsh-dot/focus', { taskId });
                            if (result?.state)
                                setState(result.state);
                            setFlash(t('focused'));
                        }
                        catch (cause) {
                            setError(`${t('failed')}: ${cause?.message ?? String(cause)}`);
                        }
                        finally {
                            setBusy(null);
                        }
                    };
                    if (!state) {
                        return h('div', { className: 'dsh-dot-panel dsh-dot-rail' }, h('style', { key: 'style' }, OPEN_DOT_CSS + RAIL_CSS), h('p', { className: 'dsh-dot-text' }, error ?? t('railLoading')));
                    }
                    const pending = state.proposals.filter((proposal) => proposal.status === 'pending');
                    const recent = state.proposals.filter((proposal) => proposal.status === 'executed').slice(0, 4);
                    const focusedTask = state.tasks.find((task) => task.id === state.focusedTaskId) ?? state.tasks[0];
                    return h('div', { className: 'dsh-dot-panel dsh-dot-rail', 'data-dsh-dot-rail': '' }, h('style', { key: 'style' }, OPEN_DOT_CSS + RAIL_CSS), h('div', { className: 'dsh-dot-header' }, h('span', { className: 'dsh-dot-mark', 'aria-hidden': true }, h(DotIcon, { size: 22, active: true })), h('div', { className: 'dsh-dot-heading' }, h('h1', { className: 'dsh-dot-title' }, t('title')), h('p', { className: 'dsh-dot-subtitle' }, `${statusLabel(state.dotStatus, t)}${state.lastResearchCompletedAt
                        ? ` · ${t('lastResearch')} ${formatTime(state.lastResearchCompletedAt)}`
                        : ''}`))), h('div', { className: 'dsh-dot-head-actions' }, h('button', {
                        type: 'button',
                        className: 'dsh-dot-btn primary',
                        onClick: openConversation,
                        disabled: !state.dotSessionId,
                    }, t('openConversation')), h('button', { type: 'button', className: 'dsh-dot-btn', onClick: () => void runNow(), disabled: busy !== null || state.dotStatus === 'running' }, busy === 'run' ? t('working') : t('runNow')), h('button', { type: 'button', className: 'dsh-dot-btn', onClick: openPanel }, t('openPanel'))), h('div', { className: 'dsh-dot-summary' }, h('span', null, h('b', null, pending.length), ` ${t('railPending')}`), h('span', null, `${t('tasks')}: ${state.tasks.length}`), h('span', null, `${t('schedules')}: ${state.schedules.length}`), h('span', null, `${t('triggers')}: ${state.triggers.length}`)), error ? h('div', { className: 'dsh-dot-error', role: 'alert' }, error) : null, flash ? h('div', { className: 'dsh-dot-flash', role: 'status' }, flash) : null, h('section', { className: 'dsh-dot-section' }, h('h2', { className: 'dsh-dot-section-title' }, t('railPending')), pending.length === 0
                        ? h('div', { className: 'dsh-dot-empty' }, t('railClear'))
                        : pending.map((proposal) => h('article', { key: proposal.id, className: 'dsh-dot-card' }, h('div', { className: 'dsh-dot-row' }, h('span', { className: `dsh-dot-risk ${proposal.risk}` }, riskLabel(proposal.risk, t)), h('span', { className: 'dsh-dot-source' }, proposal.actionType)), h('h3', { className: 'dsh-dot-proposal-title' }, proposal.title), proposal.taskId
                            ? h('p', { className: 'dsh-dot-note' }, `Task: ${state.tasks.find((task) => task.id === proposal.taskId)?.title ?? proposal.taskId}`)
                            : null, h('p', { className: 'dsh-dot-text' }, proposal.description), proposal.executionTools.length > 0
                            ? h('div', { className: 'dsh-dot-tools' }, ...proposal.executionTools.map((tool) => h('span', { key: tool, className: 'dsh-dot-chip' }, tool)))
                            : null, h('div', { className: 'dsh-dot-actions' }, h('button', {
                            type: 'button',
                            className: 'dsh-dot-btn',
                            disabled: busy === proposal.id,
                            onClick: () => void decide(proposal, 'reject'),
                        }, t('reject')), h('button', {
                            type: 'button',
                            className: 'dsh-dot-btn primary',
                            disabled: busy === proposal.id,
                            onClick: () => void decide(proposal, 'approve'),
                        }, busy === proposal.id ? t('working') : t('approve')))))), state.tasks.length > 0
                        ? h('section', { className: 'dsh-dot-section' }, h('h2', { className: 'dsh-dot-section-title' }, t('tasks')), ...state.tasks.slice(0, 6).map((task) => h('div', { key: task.id, className: 'dsh-dot-card dsh-dot-task-card', 'data-status': task.status }, h('div', { className: 'dsh-dot-row' }, h('span', { className: `dsh-dot-task-status ${task.status}` }, task.status), task.priority ? h('span', { className: 'dsh-dot-source' }, task.priority) : null, task.workerId ? h('span', { className: 'dsh-dot-source' }, `worker ${task.workerId.slice(0, 12)}`) : null), h('h3', { className: 'dsh-dot-proposal-title' }, task.title ?? task.goal ?? 'Untitled task'), h('p', { className: 'dsh-dot-text' }, task.plan ?? task.progress ?? ''), task.nextAction ? h('p', { className: 'dsh-dot-note' }, task.nextAction) : null, task.waitingFor ? h('p', { className: 'dsh-dot-note' }, `Waiting: ${task.waitingFor}`) : null, task.waitingOnTitles && task.waitingOnTitles.length > 0
                            ? h('p', { className: 'dsh-dot-note' }, `${t('waitingForDeps')}: ${task.waitingOnTitles.join(', ')}`)
                            : null, task.blockedReason ? h('p', { className: 'dsh-dot-error' }, task.blockedReason) : null, h('div', { className: 'dsh-dot-actions' }, h('button', {
                            type: 'button',
                            className: 'dsh-dot-btn',
                            disabled: busy === `focus:${task.id}`,
                            onClick: () => void focusTask(task.id),
                        }, state.focusedTaskId === task.id ? t('focused') : t('focus'))))))
                        : null, focusedTask
                        ? h('section', { className: 'dsh-dot-section' }, h('h2', { className: 'dsh-dot-section-title' }, t('taskDetail')), h('div', { className: 'dsh-dot-card' }, h('h3', { className: 'dsh-dot-proposal-title' }, focusedTask.title ?? focusedTask.goal ?? 'Untitled task'), h('p', { className: 'dsh-dot-text' }, focusedTask.plan ?? focusedTask.progress ?? ''), focusedTask.nextAction ? h('p', { className: 'dsh-dot-note' }, focusedTask.nextAction) : null, focusedTask.verifiedResult ? h('p', { className: 'dsh-dot-flash' }, focusedTask.verifiedResult) : null, h('div', { className: 'dsh-dot-actions', style: { justifyContent: 'flex-start' } }, h('button', {
                            type: 'button',
                            className: 'dsh-dot-btn',
                            disabled: busy === `focus:${focusedTask.id}`,
                            onClick: () => void focusTask(focusedTask.id),
                        }, state.focusedTaskId === focusedTask.id ? t('focused') : t('focus'))), h('h4', { className: 'dsh-dot-section-title' }, t('artifacts')), (focusedTask.artifacts ?? []).length > 0
                            ? h('div', { className: 'dsh-dot-sources' }, ...(focusedTask.artifacts ?? []).map((artifact) => h('span', { key: artifact.id }, `${artifact.kind}: ${artifact.path ?? artifact.url ?? artifact.title}`)))
                            : h('p', { className: 'dsh-dot-note' }, t('noArtifacts')), h('h4', { className: 'dsh-dot-section-title' }, t('activity')), (focusedTask.events ?? []).slice(-5).reverse().map((event) => h('div', { key: event.id, className: 'dsh-dot-recent' }, h('span', { className: 'dsh-dot-source' }, event.type), h('span', { className: 'dsh-dot-recent-text' }, event.summary), h('span', { className: 'dsh-dot-source' }, formatTime(event.at))))))
                        : null, h('section', { className: 'dsh-dot-section' }, h('h2', { className: 'dsh-dot-section-title' }, t('workers')), (state.workers ?? []).length > 0
                        ? h('div', { className: 'dsh-dot-card' }, ...(state.workers ?? []).slice(0, 6).map((worker) => h('div', { key: worker.id, className: 'dsh-dot-recent' }, h('span', { className: `dsh-dot-task-status ${worker.status}` }, worker.status), h('span', { className: 'dsh-dot-recent-text' }, worker.taskId), h('span', { className: 'dsh-dot-source' }, worker.sessionId.slice(0, 18)))))
                        : h('div', { className: 'dsh-dot-empty' }, t('noWorkers'))), state.schedules.length > 0
                        ? h('section', { className: 'dsh-dot-section' }, h('h2', { className: 'dsh-dot-section-title' }, t('schedules')), h('div', { className: 'dsh-dot-card' }, ...state.schedules.slice(0, 4).map((schedule) => h('div', { key: schedule.id, className: 'dsh-dot-recent' }, h('span', { className: 'dsh-dot-recent-text' }, schedule.title), h('span', { className: 'dsh-dot-source' }, schedule.detail)))))
                        : null, state.triggers.length > 0
                        ? h('section', { className: 'dsh-dot-section' }, h('h2', { className: 'dsh-dot-section-title' }, t('triggers')), h('div', { className: 'dsh-dot-card' }, ...state.triggers.slice(0, 4).map((trigger) => h('div', { key: trigger.id, className: 'dsh-dot-recent' }, h('span', { className: 'dsh-dot-recent-status' }, trigger.source), h('span', { className: 'dsh-dot-recent-text' }, trigger.instruction), h('span', { className: 'dsh-dot-source' }, trigger.condition)))))
                        : null, recent.length > 0
                        ? h('section', { className: 'dsh-dot-section' }, h('h2', { className: 'dsh-dot-section-title' }, t('railRecent')), h('div', { className: 'dsh-dot-card' }, ...recent.map((proposal) => h('div', { key: proposal.id, className: 'dsh-dot-recent' }, h('span', { className: 'dsh-dot-recent-status executed' }, t('executedStatus')), h('span', { className: 'dsh-dot-recent-text' }, proposal.title)))))
                        : null, state.sources.length > 0
                        ? h('section', { className: 'dsh-dot-section' }, h('h2', { className: 'dsh-dot-section-title' }, t('railSources')), h('div', { className: 'dsh-dot-sources' }, ...state.sources.map((source) => h('span', { key: source.id }, `${source.label} · ${source.kind}`))))
                        : null, h('p', { className: 'dsh-dot-note' }, t('railHint')));
                }
                function assistantBubbleTexts(text) {
                    const blocks = String(text ?? '').split(/\n\s*\n/);
                    const out = [];
                    for (const block of blocks) {
                        if (block.includes('```')) {
                            const clean = block.trim();
                            if (clean)
                                out.push(clean);
                            continue;
                        }
                        for (const line of block.split('\n')) {
                            const clean = line.trim();
                            if (clean)
                                out.push(clean);
                        }
                    }
                    return out.slice(0, 8);
                }
                /** Typewriter pacing: 300ms base + 60ms per visible character, clamped. */
                const DOT_CHAT_TYPING_MIN_MS = 300;
                const DOT_CHAT_TYPING_MAX_MS = 4_000;
                const DOT_CHAT_TYPING_MS_PER_CHAR = 60;
                function chatTypingDelay(text) {
                    const visibleLength = String(text ?? '').replace(/\s+/g, '').length;
                    return Math.min(DOT_CHAT_TYPING_MAX_MS, Math.max(DOT_CHAT_TYPING_MIN_MS, DOT_CHAT_TYPING_MIN_MS + visibleLength * DOT_CHAT_TYPING_MS_PER_CHAR));
                }
                function chatMessageSeq(message) {
                    const seq = Number(message.seq);
                    return Number.isSafeInteger(seq) && seq > 0 ? seq : undefined;
                }
                /**
                 * The only ordering authority is seq. Legacy messages without seq sort
                 * before every seq-carrying message, then by createdAt + id.
                 */
                function sortChatMessages(messages) {
                    return messages.slice().sort((left, right) => {
                        const leftSeq = chatMessageSeq(left);
                        const rightSeq = chatMessageSeq(right);
                        if (leftSeq !== undefined && rightSeq !== undefined) {
                            if (leftSeq !== rightSeq)
                                return leftSeq - rightSeq;
                        }
                        else if (leftSeq !== undefined) {
                            return 1;
                        }
                        else if (rightSeq !== undefined) {
                            return -1;
                        }
                        const time = (Number(left.at) || 0) - (Number(right.at) || 0);
                        if (time !== 0)
                            return time;
                        return String(left.id).localeCompare(String(right.id));
                    });
                }
                function mergeVisibleIds(previous, ids) {
                    if (ids.length === 0)
                        return previous;
                    const known = new Set(previous);
                    const next = previous.slice();
                    for (const id of ids) {
                        if (known.has(id))
                            continue;
                        known.add(id);
                        next.push(id);
                    }
                    return next.length === previous.length ? previous : next;
                }
                function jumpToDotMessage(id) {
                    if (!id)
                        return;
                    const target = document.getElementById(`dsh-dot-msg-${id}`);
                    if (!target)
                        return;
                    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    target.classList.remove('dsh-dot-chat-target');
                    void target.offsetWidth;
                    target.classList.add('dsh-dot-chat-target');
                    setTimeout(() => target.classList.remove('dsh-dot-chat-target'), 1_400);
                }
                function AssistantBubbles({ message, onJump }) {
                    const text = message.text;
                    const segments = assistantBubbleTexts(text);
                    const [visible, setVisible] = React.useState(1);
                    React.useEffect(() => {
                        setVisible(1);
                    }, [text]);
                    React.useEffect(() => {
                        if (visible >= segments.length)
                            return;
                        const timer = setTimeout(() => {
                            setVisible((current) => Math.min(current + 1, segments.length));
                        }, 230);
                        return () => clearTimeout(timer);
                    }, [visible, segments.length]);
                    if (segments.length === 0)
                        return null;
                    return h('div', { className: 'dsh-dot-chat-bubbles', id: `dsh-dot-msg-${message.id}` }, message.replyTo
                        ? h('button', {
                            type: 'button',
                            className: 'dsh-dot-chat-quote',
                            onClick: () => (onJump ? onJump(message.replyTo) : jumpToDotMessage(message.replyTo)),
                            title: '跳到被引用的消息',
                        }, h('span', { className: 'dsh-dot-chat-quote-role' }, message.replyToRole === 'assistant' ? 'Dot' : '你'), h('span', { className: 'dsh-dot-chat-quote-text' }, message.replyToPreview || '原消息'))
                        : null, segments.slice(0, visible).map((segment, index) => h('div', {
                        key: `${index}-${segment.slice(0, 16)}`,
                        className: `dsh-dot-chat-msg assistant dsh-dot-chat-segment${index === Math.min(visible, segments.length) - 1 ? ' tail' : ''}`,
                    }, segment)));
                }
                function DotChatPanel() {
                    const [state, setState] = React.useState(null);
                    const [draft, setDraft] = React.useState('');
                    const [busy, setBusy] = React.useState(false);
                    const [error, setError] = React.useState(null);
                    const [visibleIds, setVisibleIds] = React.useState([]);
                    const [queueVersion, setQueueVersion] = React.useState(0);
                    const revealQueue = React.useRef([]);
                    const seenMessageIds = React.useRef(new Set());
                    const initialized = React.useRef(false);
                    const stickToBottom = React.useRef(true);
                    const scrollRef = React.useRef(null);
                    const contentRef = React.useRef(null);
                    const composeRef = React.useRef(null);
                    const [composerBox, setComposerBox] = React.useState(120);
                    const inputRef = React.useRef(null);
                    const fileInputRef = React.useRef(null);
                    const [pendingImages, setPendingImages] = React.useState([]);
                    const [imageError, setImageError] = React.useState(null);
                    const [composerHeight, setComposerHeight] = React.useState(44);
                    React.useEffect(() => {
                        let active = true;
                        let timer;
                        const load = async () => {
                            try {
                                const next = (await railRequest('/dsh-dot/state'));
                                if (active)
                                    setState(next);
                            }
                            catch (cause) {
                                if (active)
                                    setError(`${tr('failed')}: ${cause?.message ?? String(cause)}`);
                            }
                            finally {
                                if (active)
                                    timer = setTimeout(load, 1_500);
                            }
                        };
                        void load();
                        return () => {
                            active = false;
                            if (timer)
                                clearTimeout(timer);
                        };
                    }, []);
                    React.useEffect(() => {
                        resizeComposer();
                    }, [draft]);
                    const messages = sortChatMessages(state?.chatMessages ?? []);
                    const visibleSet = new Set(visibleIds);
                    React.useEffect(() => {
                        if (!state)
                            return;
                        const list = sortChatMessages(state.chatMessages ?? []);
                        if (!initialized.current) {
                            // Existing history appears at once; only live arrivals are staged.
                            initialized.current = true;
                            for (const message of list)
                                seenMessageIds.current.add(message.id);
                            setVisibleIds((previous) => mergeVisibleIds(previous, list.map((message) => message.id)));
                            return;
                        }
                        const revealNow = [];
                        let queuedNew = false;
                        let clearedQueue = false;
                        for (const message of list) {
                            if (seenMessageIds.current.has(message.id))
                                continue;
                            seenMessageIds.current.add(message.id);
                            if (message.role === 'user') {
                                // A user message wins over the typing rhythm: flush everything
                                // still queued so the rendered order always matches seq order.
                                if (revealQueue.current.length > 0) {
                                    revealNow.push(...revealQueue.current.map((item) => item.id));
                                    revealQueue.current = [];
                                    clearedQueue = true;
                                }
                                revealNow.push(message.id);
                                continue;
                            }
                            if (revealQueue.current.length === 0 && revealNow.length === 0) {
                                revealNow.push(message.id);
                            }
                            else {
                                revealQueue.current.push({ id: message.id, delay: chatTypingDelay(message.text) });
                                queuedNew = true;
                            }
                        }
                        if (revealNow.length > 0) {
                            setVisibleIds((previous) => mergeVisibleIds(previous, revealNow));
                        }
                        if (queuedNew || clearedQueue)
                            setQueueVersion((version) => version + 1);
                    }, [state]);
                    React.useEffect(() => {
                        const next = revealQueue.current[0];
                        if (!next)
                            return;
                        const timer = setTimeout(() => {
                            const revealed = revealQueue.current.shift();
                            if (revealed)
                                setVisibleIds((previous) => mergeVisibleIds(previous, [revealed.id]));
                            setQueueVersion((version) => version + 1);
                        }, next.delay);
                        return () => clearTimeout(timer);
                    }, [queueVersion]);
                    const shownMessages = initialized.current
                        ? messages.filter((message) => visibleSet.has(message.id))
                        : messages;
                    React.useEffect(() => {
                        const node = scrollRef.current;
                        if (node && stickToBottom.current)
                            node.scrollTop = node.scrollHeight;
                    }, [shownMessages.length, state?.dotStatus]);
                    React.useEffect(() => {
                        const node = composeRef.current;
                        if (!node)
                            return;
                        let disposed = false;
                        const measure = () => {
                            if (!disposed)
                                setComposerBox(node.getBoundingClientRect().height);
                        };
                        measure();
                        const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : undefined;
                        observer?.observe(node);
                        return () => {
                            disposed = true;
                            observer?.disconnect();
                        };
                    }, []);
                    React.useEffect(() => {
                        const scroller = scrollRef.current;
                        const content = contentRef.current;
                        if (!scroller)
                            return;
                        let disposed = false;
                        const keep = () => {
                            if (!disposed && stickToBottom.current)
                                scroller.scrollTop = scroller.scrollHeight;
                        };
                        const observer = typeof ResizeObserver !== 'undefined' && content ? new ResizeObserver(keep) : undefined;
                        observer?.observe(content);
                        keep();
                        const timers = [60, 320, 900, 1_800].map((delay) => setTimeout(keep, delay));
                        return () => {
                            disposed = true;
                            observer?.disconnect();
                            for (const timer of timers)
                                clearTimeout(timer);
                        };
                    }, []);
                    const onScroll = (event) => {
                        const node = event.currentTarget;
                        stickToBottom.current =
                            node.scrollHeight - node.scrollTop - node.clientHeight < 80;
                    };
                    /** The user is taking the turn: show anything still waiting right away. */
                    const flushRevealQueue = () => {
                        if (revealQueue.current.length === 0)
                            return;
                        const ids = revealQueue.current.map((item) => item.id);
                        revealQueue.current = [];
                        setVisibleIds((previous) => mergeVisibleIds(previous, ids));
                        setQueueVersion((version) => version + 1);
                    };
                    const resizeComposer = () => {
                        const node = inputRef.current;
                        if (!node)
                            return;
                        node.style.height = 'auto';
                        const next = Math.min(160, Math.max(44, node.scrollHeight));
                        node.style.height = `${next}px`;
                        node.style.overflowY = node.scrollHeight > 160 ? 'auto' : 'hidden';
                        setComposerHeight(next);
                    };
                    const readImage = (file) => new Promise((resolve, reject) => {
                        if (!file.type.startsWith('image/')) {
                            reject(new Error('只能上传图片'));
                            return;
                        }
                        if (file.size > 10 * 1024 * 1024) {
                            reject(new Error('单张图片不能超过 10MB'));
                            return;
                        }
                        const reader = new FileReader();
                        reader.onerror = () => reject(new Error('图片读取失败'));
                        reader.onload = () => {
                            const dataUrl = String(reader.result ?? '');
                            const comma = dataUrl.indexOf(',');
                            if (comma < 0) {
                                reject(new Error('图片读取失败'));
                                return;
                            }
                            resolve({ name: file.name || 'screenshot', mediaType: file.type, data: dataUrl.slice(comma + 1), dataUrl });
                        };
                        reader.readAsDataURL(file);
                    });
                    const addImages = async (files) => {
                        setImageError(null);
                        const room = Math.max(0, 4 - pendingImages.length);
                        const accepted = files.filter((file) => file.type.startsWith('image/')).slice(0, room);
                        if (accepted.length === 0)
                            return;
                        try {
                            const next = await Promise.all(accepted.map(readImage));
                            setPendingImages((current) => [...current, ...next].slice(0, 4));
                        }
                        catch (cause) {
                            setImageError(cause instanceof Error ? cause.message : String(cause));
                        }
                    };
                    const onPaste = (event) => {
                        const files = Array.from(event.clipboardData?.items ?? [])
                            .filter((item) => item.kind === 'file' && String(item.type).startsWith('image/'))
                            .map((item) => item.getAsFile())
                            .filter(Boolean);
                        if (files.length > 0) {
                            event.preventDefault();
                            void addImages(files);
                        }
                    };
                    const send = async () => {
                        const text = draft.trim();
                        if ((!text && pendingImages.length === 0) || busy)
                            return;
                        flushRevealQueue();
                        stickToBottom.current = true;
                        setDraft('');
                        if (inputRef.current) {
                            inputRef.current.value = '';
                            inputRef.current.style.height = '44px';
                        }
                        setComposerHeight(44);
                        setBusy(true);
                        setError(null);
                        setImageError(null);
                        try {
                            const result = await railRequest('/dsh-dot/chat', {
                                text,
                                images: pendingImages.map((image) => ({
                                    name: image.name,
                                    mediaType: image.mediaType,
                                    data: image.data,
                                })),
                            });
                            if (result?.state)
                                setState(result.state);
                            setPendingImages([]);
                        }
                        catch (cause) {
                            setError(`${tr('failed')}: ${cause?.message ?? String(cause)}`);
                        }
                        finally {
                            setBusy(false);
                        }
                    };
                    const decide = async (proposalId, decision) => {
                        setBusy(true);
                        setError(null);
                        try {
                            const result = await railRequest('/dsh-dot/decision', { proposalId, decision });
                            if (result?.state)
                                setState(result.state);
                        }
                        catch (cause) {
                            setError(`${tr('failed')}: ${cause?.message ?? String(cause)}`);
                        }
                        finally {
                            setBusy(false);
                        }
                    };
                    const pending = state?.proposals?.filter((proposal) => proposal.status === 'pending') ?? [];
                    const working = busy || state?.dotStatus === 'running' || revealQueue.current.length > 0;
                    const jumpWithPause = (id) => {
                        stickToBottom.current = false;
                        jumpToDotMessage(id);
                        setTimeout(() => {
                            stickToBottom.current = true;
                        }, 1_600);
                    };
                    return h('div', { className: 'dsh-dot-chat' }, h('style', { key: 'style' }, DOT_CHAT_CSS), h('header', { className: 'dsh-dot-chat-head' }, h('span', { className: 'dsh-dot-chat-mark' }, h(DotIcon, { size: 21, active: true })), h('div', { className: 'dsh-dot-chat-title' }, h('h1', null, 'Dot'), h('p', null, '你的个人助手 · 任务管理者'))), h('div', { className: 'dsh-dot-chat-body' }, h('div', {
                        className: 'dsh-dot-chat-scroll',
                        ref: scrollRef,
                        onScroll,
                        style: { paddingBottom: `${Math.round(composerBox) + 28}px` },
                    }, h('div', { className: 'dsh-dot-chat-content', ref: contentRef }, messages.length === 0
                        ? h('div', { className: 'dsh-dot-chat-empty' }, '我是你的 Dot。\n把你想让我管理的事情交给我，我会安排、跟踪，并在有结果时告诉你。')
                        : shownMessages.map((message) => message.role === 'assistant'
                            ? h(AssistantBubbles, { key: message.id, message, onJump: jumpWithPause })
                            : h('div', { key: message.id, id: `dsh-dot-msg-${message.id}`, className: 'dsh-dot-chat-msg user tail' }, message.images?.length
                                ? h('div', { className: 'dsh-dot-chat-images' }, message.images.map((image) => h('img', {
                                    key: image.attachmentId,
                                    src: `/dsh-dot/attachment/${encodeURIComponent(image.attachmentId)}`,
                                    alt: image.name || '截图',
                                    loading: 'lazy',
                                })))
                                : null, message.text ? h('span', null, message.text) : null)), pending.map((proposal) => h('div', { key: proposal.id, className: 'dsh-dot-chat-approval' }, h('div', { className: 'dsh-dot-chat-approval-title' }, '需要你确认'), h('div', null, proposal.title), h('div', { className: 'dsh-dot-chat-approval-actions' }, h('button', {
                        className: 'dsh-dot-chat-btn',
                        type: 'button',
                        disabled: busy,
                        onClick: () => void decide(proposal.id, 'reject'),
                    }, '拒绝'), h('button', {
                        className: 'dsh-dot-chat-btn primary',
                        type: 'button',
                        disabled: busy,
                        onClick: () => void decide(proposal.id, 'approve'),
                    }, '批准')))), working
                        ? h('div', {
                            className: 'dsh-dot-chat-thinking',
                            role: 'status',
                            'aria-label': 'Dot 正在处理',
                        }, h('svg', {
                            className: 'dsh-dot-chat-thinking-dot',
                            viewBox: '0 0 16 16',
                            'aria-hidden': true,
                            focusable: 'false',
                        }, h('circle', { cx: 8, cy: 8, r: 6, fill: 'currentColor' })))
                        : null)), h('div', { className: 'dsh-dot-chat-compose', ref: composeRef }, h('div', { className: 'dsh-dot-chat-composer' }, pendingImages.length > 0
                        ? h('div', { className: 'dsh-dot-chat-previews' }, pendingImages.map((image, index) => h('div', { className: 'dsh-dot-chat-preview', key: `${index}-${image.name}` }, h('img', { src: image.dataUrl, alt: image.name }), h('button', {
                            type: 'button',
                            title: '移除图片',
                            onClick: () => setPendingImages((current) => current.filter((_, i) => i !== index)),
                        }, '×'))))
                        : null, h('div', { className: 'dsh-dot-chat-input-wrap' }, h('textarea', {
                        className: 'dsh-dot-chat-input',
                        ref: inputRef,
                        value: draft,
                        rows: 1,
                        style: { height: `${composerHeight}px` },
                        placeholder: '给 Dot 发送消息',
                        onChange: (event) => {
                            setDraft(event.target.value);
                            setTimeout(resizeComposer, 0);
                        },
                        onPaste,
                        onInput: () => resizeComposer(),
                        onKeyDown: (event) => {
                            if (event.key === 'Enter' && !event.shiftKey) {
                                event.preventDefault();
                                void send();
                            }
                        },
                    })), h('div', { className: 'dsh-dot-chat-actions' }, h('input', {
                        type: 'file',
                        accept: 'image/png,image/jpeg,image/webp,image/gif',
                        multiple: true,
                        style: { display: 'none' },
                        ref: fileInputRef,
                        onChange: (event) => {
                            const files = Array.from(event.target.files ?? []);
                            void addImages(files);
                            event.target.value = '';
                        },
                    }), h('button', {
                        type: 'button',
                        className: 'dsh-dot-chat-image-btn',
                        title: '添加图片',
                        'aria-label': '添加图片',
                        disabled: busy || pendingImages.length >= 4,
                        onClick: () => fileInputRef.current?.click(),
                    }, h('svg', {
                        className: 'dsh-dot-chat-icon',
                        viewBox: '0 0 18 18',
                        'aria-hidden': true,
                        focusable: 'false',
                    }, h('path', {
                        d: 'M9 3.75v10.5M3.75 9h10.5',
                        fill: 'none',
                        stroke: 'currentColor',
                        'stroke-width': 1.6,
                        'stroke-linecap': 'round',
                    }))), h('button', {
                        className: 'dsh-dot-chat-send',
                        type: 'button',
                        disabled: busy || (!draft.trim() && pendingImages.length === 0),
                        onClick: () => void send(),
                        title: '发送',
                        'aria-label': '发送',
                    }, h('svg', {
                        className: 'dsh-dot-chat-icon',
                        viewBox: '0 0 18 18',
                        'aria-hidden': true,
                        focusable: 'false',
                    }, h('path', {
                        d: 'M9 14.25V4.5M4.9 8.6 9 4.5l4.1 4.1',
                        fill: 'none',
                        stroke: 'currentColor',
                        'stroke-width': 1.6,
                        'stroke-linecap': 'round',
                        'stroke-linejoin': 'round',
                    }))))), error ? h('div', { className: 'dsh-dot-chat-error' }, error) : null, imageError ? h('div', { className: 'dsh-dot-chat-error' }, imageError) : null)));
                }
                function DotGateway() {
                    const [error, setError] = React.useState(null);
                    React.useEffect(() => {
                        let active = true;
                        const run = async () => {
                            try {
                                const next = (await railRequest('/dsh-dot/state'));
                                const uiWorkspace = ctx.get?.('uiWorkspace');
                                if (!active)
                                    return;
                                if (uiWorkspace?.openSession && next?.dotSessionId) {
                                    uiWorkspace.openSession(next.dotSessionId);
                                    return;
                                }
                                setError(tr('railNoSession'));
                            }
                            catch (cause) {
                                if (active)
                                    setError(`${tr('failed')}: ${cause?.message ?? String(cause)}`);
                            }
                        };
                        void run();
                        return () => {
                            active = false;
                        };
                    }, []);
                    return h('div', { className: 'dsh-dot-gateway' }, h('style', { key: 'style' }, CHAT_CSS), h('span', { className: 'dsh-dot-gateway-mark' }, h(DotIcon, { size: 30, active: true })), h('p', null, error ?? tr('railLoading')));
                }
                function DotPresence(props) {
                    const t = props.t ?? tr;
                    const [state, setState] = React.useState(null);
                    React.useEffect(() => {
                        let active = true;
                        let timer;
                        const load = async () => {
                            try {
                                const next = (await railRequest('/dsh-dot/state'));
                                if (active)
                                    setState(next);
                            }
                            catch {
                                // keep the last known state
                            }
                            finally {
                                if (active)
                                    timer = setTimeout(load, 2_000);
                            }
                        };
                        void load();
                        return () => {
                            active = false;
                            if (timer)
                                clearTimeout(timer);
                        };
                    }, []);
                    if (!state?.dotSessionId || String(state.dotSessionId) !== String(props.sessionId))
                        return null;
                    const busy = state.dotStatus === 'running';
                    return h('span', { className: 'dsh-dot-presence-wrap' }, h('style', { key: 'style' }, CHAT_CSS + '[data-turn-process]{display:none!important}'), h('span', { className: `dsh-dot-presence ${busy ? 'busy' : 'idle'}`, title: busy ? t('running') : t('title') }, h('span', { className: 'dsh-dot-presence-dot', 'aria-hidden': true }), h('span', null, busy ? t('running') : t('title'))));
                }
                function DotHeaderAction(props) {
                    const t = props.t ?? tr;
                    const [isDotSession, setIsDotSession] = React.useState(null);
                    React.useEffect(() => {
                        let active = true;
                        let timer;
                        const check = async () => {
                            try {
                                const next = (await railRequest('/dsh-dot/state'));
                                if (active) {
                                    const mine = Boolean(next?.dotSessionId && String(next.dotSessionId) === String(props.sessionId));
                                    setIsDotSession(mine);
                                    if (!mine)
                                        return;
                                    timer = setTimeout(() => {
                                        try {
                                            ctx.sidebarRight.openTab(TAB_KIND);
                                        }
                                        catch {
                                            // The right sidebar may not have adopted this Session yet.
                                        }
                                    }, 350);
                                }
                            }
                            catch {
                                if (active)
                                    setIsDotSession(null);
                            }
                        };
                        void check();
                        return () => {
                            active = false;
                            if (timer)
                                clearTimeout(timer);
                        };
                    }, [props.sessionId]);
                    if (isDotSession !== true)
                        return null;
                    return h('button', {
                        type: 'button',
                        className: 'dsh-dot-header-action',
                        title: t('title'),
                        onClick: () => {
                            try {
                                ctx.sidebarRight.openTab(TAB_KIND);
                            }
                            catch {
                                // ignore; the header is still mounted while the Session settles
                            }
                        },
                    }, h(DotIcon, { size: 15, active: true }), h('span', null, t('dotShort')));
                }
                function DotFooterAction(props) {
                    const t = props.t ?? tr;
                    const [busy, setBusy] = React.useState(false);
                    const open = async () => {
                        setBusy(true);
                        try {
                            const next = (await railRequest('/dsh-dot/state'));
                            const uiWorkspace = ctx.get?.('uiWorkspace');
                            if (uiWorkspace?.openSession && next?.dotSessionId) {
                                uiWorkspace.openSession(next.dotSessionId);
                                setTimeout(() => {
                                    try {
                                        ctx.sidebarRight.openTab(TAB_KIND);
                                    }
                                    catch {
                                        // The Session may still be settling; the header action can open it after mount.
                                    }
                                }, 500);
                            }
                        }
                        catch {
                            // no-op; the main panel exposes the current error
                        }
                        finally {
                            setBusy(false);
                        }
                    };
                    return h('button', {
                        type: 'button',
                        className: 'dsh-dot-footer-action',
                        disabled: busy,
                        title: t('openConversation'),
                        onClick: () => void open(),
                    }, h(DotIcon, { size: 17, active: true }), props.wide ? h('span', null, t('title')) : null);
                }
                function DotTabTitle(props) {
                    const t = props.t ?? tr;
                    return h('span', { className: 'dsh-dot-tab-title' }, h(DotIcon, { size: 14, active: true }), h('span', null, t('title')));
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
                }, DotChatPanel));
            },
        };
    },
});
