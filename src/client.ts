/**
 * DSH Dot Client panel.
 *
 * A dedicated main panel plus a sidebar icon. The panel is the user-only
 * control surface: it reads proposals and submits approve/reject decisions.
 * The Dot Agent has no Tool that can call these endpoints.
 */

interface Window {
  __ModuleLoader__: {
    load(spec: { id: string; factory(require: (name: string) => any): any }): void
  }
}

interface ReactLike {
  createElement(type: any, props?: any, ...children: any[]): any
  useState<T>(initial: T): [T, (value: T | ((current: T) => T)) => void]
  useEffect(effect: () => void | (() => void), deps?: any[]): void
}

interface Proposal {
  id: string
  title: string
  description: string
  proposedAction: string
  actionType: string
  source: string
  evidence: string
  risk: 'low' | 'medium' | 'high'
  riskReason: string
  decision: 'allow' | 'ask' | 'deny'
  status: 'pending' | 'approved' | 'rejected' | 'executing' | 'executed' | 'failed'
  executionTools: string[]
  executionInstruction: string
  createdAt: number
  updatedAt: number
  result?: string
  error?: string
  taskId?: string
  workerId?: string
}

interface Schedule {
  id: string
  title: string
  kind: string
  detail: string
  scheduledAt?: string
}

interface Source {
  id: string
  kind: string
  label: string
  path?: string
  url?: string
}

interface DotState {
  ok: true
  version: 2
  enabled: boolean
  dotSessionId?: string
  dotStatus: 'starting' | 'idle' | 'running' | 'error'
  sources: Source[]
  proposals: Proposal[]
  tasks: Array<{
    id: string
    title?: string
    goal?: string
    request?: string
    status: string
    plan?: string
    progress?: string
    nextAction?: string
    priority?: string
    workerId?: string
    waitingFor?: string
    blockedReason?: string
    verifiedResult?: string
    artifacts?: Array<{ id: string; title: string; path?: string; url?: string; kind: string }>
    events?: Array<{ id: string; at: number; actor: string; type: string; summary: string }>
  }>
  workers?: Array<{
    id: string
    taskId: string
    sessionId: string
    status: string
    lastResult?: string
    lastError?: string
  }>
  focusedTaskId?: string
  triggers: Array<{ id: string; source: string; condition: string; instruction: string }>
  schedules: Schedule[]
  lastResearchAt?: number
  lastResearchCompletedAt?: number
  lastError?: string
  executionTools: string[]
}

const NS = 'dsh-dot'
const TAB_KIND = 'dsh-dot'
const TAB_ID = 'dsh-dot-plugin/rail'

const zh: Record<string, string> = {
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
  condition: '条件',
  detail: '计划',
}

const en: Record<string, string> = {
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
  condition: 'Condition',
  detail: 'Schedule',
}

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
`

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
`

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
`

window.__ModuleLoader__.load({
  id: 'dsh-dot-plugin',
  factory(require) {
    const React = require('react') as ReactLike
    const h = React.createElement

    return {
      name: 'dsh-dot-client',
      inject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'],
      apply(ctx: any) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-dot: client locale')
        const bound = ctx.locale.bind(NS)
        const tr = (key: string, vars?: Record<string, unknown>) => {
          try {
            return bound(key, vars)
          } catch {
            return en[key] ?? key
          }
        }

        const railRequest = async (path: string, body?: unknown) => {
          const response = await fetch(path, {
            method: body === undefined ? 'GET' : 'POST',
            cache: 'no-store',
            headers:
              body === undefined
                ? { accept: 'application/json' }
                : { 'content-type': 'application/json', 'x-dsh-dot': '1' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          })
          const payload = (await response.json().catch(() => null)) as any
          if (!response.ok) {
            throw new Error(payload?.error || payload?.reason || `HTTP ${response.status}`)
          }
          return payload
        }


        function DotIcon(props: { size?: number; active?: boolean }) {
          const size = props.size ?? 20
          const color = props.active ? 'var(--dsw-alias-brand-primary)' : 'currentColor'
          return h(
            'svg',
            {
              viewBox: '0 0 24 24',
              width: size,
              height: size,
              'aria-hidden': true,
              style: { display: 'block', color },
            },
            h('circle', {
              cx: 12,
              cy: 12,
              r: 8.4,
              fill: 'none',
              stroke: 'currentColor',
              'stroke-width': 1.5,
              opacity: '.45',
            }),
            h('circle', {
              cx: 12,
              cy: 12,
              r: 4.7,
              fill: 'none',
              stroke: 'currentColor',
              'stroke-width': 1.5,
              opacity: '.75',
            }),
            h('circle', { cx: 12, cy: 12, r: 1.9, fill: 'currentColor' }),
            h('circle', { cx: 19, cy: 5, r: 1.1, fill: 'currentColor' }),
          )
        }

        function DotPanel(props: {
          t?: (key: string, vars?: Record<string, unknown>) => string
        }) {
          const t = props.t ?? tr
          const [state, setState] = React.useState<DotState | null>(null)
          const [busy, setBusy] = React.useState<string | null>(null)
          const [error, setError] = React.useState<string | null>(null)
          const [flash, setFlash] = React.useState<string | null>(null)

          const request = async (path: string, body?: unknown) => {
            const response = await fetch(path, {
              method: body === undefined ? 'GET' : 'POST',
              cache: 'no-store',
              headers:
                body === undefined
                  ? { accept: 'application/json' }
                  : { 'content-type': 'application/json', 'x-dsh-dot': '1' },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            })
            const payload = (await response.json().catch(() => null)) as any
            if (!response.ok) {
              throw new Error(payload?.error || payload?.reason || `HTTP ${response.status}`)
            }
            return payload
          }

          const refresh = async () => {
            try {
              const next = (await request('/dsh-dot/state')) as DotState
              if (next?.ok) {
                setState(next)
                setError(null)
              }
            } catch (cause) {
              setError(`${t('errorRead')} ${(cause as any)?.message ?? ''}`.trim())
            }
          }

          React.useEffect(() => {
            let cancelled = false
            let timer: ReturnType<typeof setTimeout> | undefined
            const load = async () => {
              try {
                const next = (await request('/dsh-dot/state')) as DotState
                if (!cancelled && next?.ok) {
                  setState(next)
                  setError(null)
                }
              } catch (cause) {
                if (!cancelled) {
                  setError(`${t('errorRead')} ${(cause as any)?.message ?? ''}`.trim())
                }
              } finally {
                if (!cancelled) timer = setTimeout(load, 2_000)
              }
            }
            void load()
            const onVisible = () => {
              if (document.visibilityState === 'visible' && !cancelled) {
                if (timer) clearTimeout(timer)
                void load()
              }
            }
            document.addEventListener('visibilitychange', onVisible)
            return () => {
              cancelled = true
              if (timer) clearTimeout(timer)
              document.removeEventListener('visibilitychange', onVisible)
            }
          }, [])

          const runNow = async () => {
            setBusy('run')
            setError(null)
            setFlash(null)
            try {
              const result = await request('/dsh-dot/check', { reason: 'panel' })
              if (result?.state) setState(result.state)
              setFlash(result?.started ? t('running') : String(result?.reason ?? ''))
            } catch (cause) {
              setError(`${t('failed')}: ${(cause as any)?.message ?? String(cause)}`)
            } finally {
              setBusy(null)
            }
          }

          const decide = async (proposal: Proposal, decision: 'approve' | 'reject') => {
            setBusy(proposal.id)
            setError(null)
            setFlash(null)
            try {
              const result = await request('/dsh-dot/decision', {
                proposalId: proposal.id,
                decision,
              })
              if (result?.state) setState(result.state)
              setFlash(decision === 'approve' ? t('approved') : t('rejected'))
            } catch (cause) {
              setError(`${t('failed')}: ${(cause as any)?.message ?? String(cause)}`)
            } finally {
              setBusy(null)
            }
          }

          const openConversation = () => {
            if (!state?.dotSessionId) {
              setError(t('noSession'))
              return
            }
            try {
              const uiWorkspace = ctx.get?.('uiWorkspace')
              if (!uiWorkspace || typeof uiWorkspace.openSession !== 'function') {
                throw new Error('uiWorkspace service is unavailable')
              }
              uiWorkspace.openSession(state.dotSessionId)
            } catch (cause) {
              setError(`${t('failed')}: ${(cause as any)?.message ?? String(cause)}`)
            }
          }

          const pending = (state?.proposals ?? []).filter((proposal) => proposal.status === 'pending')
          const recent = (state?.proposals ?? []).filter((proposal) => proposal.status !== 'pending')

          return h(
            'div',
            { className: 'dsh-dot-panel', 'data-dsh-dot': 'panel' },
            h('style', { key: 'style' }, OPEN_DOT_CSS),
            h(
              'header',
              { className: 'dsh-dot-header' },
              h('span', { className: 'dsh-dot-mark', 'aria-hidden': true }, h(DotIcon, { size: 28, active: true })),
              h(
                'div',
                { className: 'dsh-dot-heading' },
                h('h1', { className: 'dsh-dot-title' }, t('title')),
                h('p', { className: 'dsh-dot-subtitle' }, t('subtitle')),
              ),
              h(
                'div',
                { className: 'dsh-dot-head-actions' },
                h(
                  'span',
                  { className: 'dsh-dot-status' },
                  h('span', {
                    className: `dsh-dot-dot ${
                      state?.dotStatus === 'running' ? 'running' : state?.dotStatus === 'error' ? 'error' : ''
                    }`,
                  }),
                  statusLabel(state?.dotStatus, t),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-dot-btn primary',
                    onClick: openConversation,
                    disabled: !state?.dotSessionId,
                  },
                  t('openConversation'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-dot-btn',
                    onClick: () => void runNow(),
                    disabled: busy !== null || state?.dotStatus === 'running',
                  },
                  busy === 'run' ? t('working') : t('runNow'),
                ),
              ),
            ),
            state
              ? h(
                  'div',
                  { key: 'summary', className: 'dsh-dot-summary' },
                  h('span', null, h('b', null, pending.length), ` ${t('pending')}`),
                  h(
                    'span',
                    null,
                    `${t('sources')}: ${state.sources.length}`,
                  ),
                  h(
                    'span',
                    null,
                    `${t('lastResearch')}: ${
                      state.lastResearchCompletedAt
                        ? formatTime(state.lastResearchCompletedAt)
                        : state.lastResearchAt
                          ? t('running')
                          : t('never')
                    }`,
                  ),
                  h(
                    'span',
                    null,
                    `${t('executionTools')}: ${state.executionTools.join(', ') || '—'}`,
                  ),
                )
              : null,
            state && state.sources.length > 0
              ? h(
                  'div',
                  { key: 'sources', className: 'dsh-dot-sources' },
                  ...state.sources.map((source) =>
                    h(
                      'span',
                      { key: source.id },
                      `${source.label} · ${source.kind}${source.path ? ` · ${source.path}` : source.url ? ` · ${source.url}` : ''}`,
                    ),
                  ),
                )
              : state
                ? h('p', { key: 'nosources', className: 'dsh-dot-text' }, t('noSources'))
                : null,
            error ? h('div', { key: 'error', className: 'dsh-dot-error', role: 'alert' }, error) : null,
            flash ? h('div', { key: 'flash', className: 'dsh-dot-flash', role: 'status' }, flash) : null,
            h(
              'section',
              { key: 'pending', className: 'dsh-dot-section' },
              h('h2', { className: 'dsh-dot-section-title' }, `${t('pending')} · ${pending.length}`),
              ...pending.map((proposal) => renderProposal(proposal, busy, decide, t)),
              pending.length === 0
                ? h('div', { className: 'dsh-dot-empty' }, t('noProposals'))
                : null,
            ),
            recent.length > 0
              ? h(
                  'section',
                  { key: 'recent', className: 'dsh-dot-section' },
                  h('h2', { className: 'dsh-dot-section-title' }, t('recent')),
                  h(
                    'div',
                    { className: 'dsh-dot-card' },
                    ...recent.slice(0, 8).map((proposal) =>
                      h(
                        'div',
                        { key: proposal.id, className: 'dsh-dot-recent' },
                        h(
                          'span',
                          { className: `dsh-dot-recent-status ${proposal.status}` },
                          statusLabel(proposal.status, t),
                        ),
                        h('span', { className: 'dsh-dot-recent-text' }, proposal.title),
                        proposal.result
                          ? h(
                              'span',
                              {
                                className: 'dsh-dot-recent-text',
                                title: proposal.result,
                              },
                              proposal.result.slice(0, 100),
                            )
                          : null,
                      ),
                    ),
                  ),
                )
              : null,
            state && state.tasks.length > 0
              ? h(
                  'section',
                  { key: 'tasks', className: 'dsh-dot-section' },
                  h('h2', { className: 'dsh-dot-section-title' }, t('tasks')),
                  ...state.tasks.map((task) =>
                    h(
                      'div',
                      { key: task.id, className: 'dsh-dot-card dsh-dot-task-card', 'data-status': task.status },
                      h(
                        'div',
                        { className: 'dsh-dot-row' },
                        h('span', { className: `dsh-dot-task-status ${task.status}` }, task.status),
                        task.priority ? h('span', { className: 'dsh-dot-source' }, task.priority) : null,
                        task.workerId ? h('span', { className: 'dsh-dot-source' }, task.workerId.slice(0, 14)) : null,
                      ),
                      h('div', { className: 'dsh-dot-proposal-title' }, task.title ?? task.goal ?? 'Untitled task'),
                      h('p', { className: 'dsh-dot-text' }, task.plan ?? task.progress ?? ''),
                      task.nextAction ? h('p', { className: 'dsh-dot-note' }, task.nextAction) : null,
                      task.waitingFor ? h('p', { className: 'dsh-dot-note' }, `Waiting: ${task.waitingFor}`) : null,
                      task.blockedReason ? h('p', { className: 'dsh-dot-error' }, task.blockedReason) : null,
                    ),
                  ),
                )
              : null,
            h(
              'section',
              { key: 'schedules', className: 'dsh-dot-section' },
              h('h2', { className: 'dsh-dot-section-title' }, t('schedules')),
              state && state.schedules.length > 0
                ? h(
                    'div',
                    { className: 'dsh-dot-card' },
                    ...state.schedules.map((schedule) =>
                      h(
                        'div',
                        { key: schedule.id, className: 'dsh-dot-recent' },
                        h('span', { className: 'dsh-dot-recent-status' }, schedule.kind),
                        h('span', { className: 'dsh-dot-recent-text' }, schedule.title),
                        h('span', { className: 'dsh-dot-source' }, schedule.detail),
                      ),
                    ),
                  )
                : h('div', { className: 'dsh-dot-empty' }, t('emptySchedules')),
            ),
            h(
              'section',
              { key: 'triggers', className: 'dsh-dot-section' },
              h('h2', { className: 'dsh-dot-section-title' }, t('triggers')),
              state && state.triggers.length > 0
                ? h(
                    'div',
                    { className: 'dsh-dot-card' },
                    ...state.triggers.map((trigger) =>
                      h(
                        'div',
                        { key: trigger.id, className: 'dsh-dot-recent' },
                        h('span', { className: 'dsh-dot-recent-status' }, trigger.source),
                        h('span', { className: 'dsh-dot-recent-text' }, trigger.instruction),
                        h('span', { className: 'dsh-dot-source' }, `${t('condition')}: ${trigger.condition}`),
                      ),
                    ),
                  )
                : h('div', { className: 'dsh-dot-empty' }, t('emptyTriggers')),
            ),
                        h('p', { key: 'note', className: 'dsh-dot-note' }, t('autoNote')),
          )
        }

        function renderProposal(
          proposal: Proposal,
          busy: string | null,
          decide: (proposal: Proposal, decision: 'approve' | 'reject') => Promise<void>,
          t: (key: string, vars?: Record<string, unknown>) => string,
        ) {
          const isBusy = busy === proposal.id
          return h(
            'article',
            { key: proposal.id, className: 'dsh-dot-card' },
            h(
              'div',
              { className: 'dsh-dot-row' },
              h(
                'span',
                { className: `dsh-dot-risk ${proposal.risk}` },
                riskLabel(proposal.risk, t),
              ),
              h('span', { className: 'dsh-dot-source' }, proposal.source),
              h('span', { className: 'dsh-dot-source' }, proposal.actionType),
            ),
            h('h3', { className: 'dsh-dot-proposal-title' }, proposal.title),
            h('p', { className: 'dsh-dot-text' }, proposal.description),
            h(
              'p',
              { className: 'dsh-dot-block' },
              h('b', null, `${t('proposedAction')}: `),
              proposal.proposedAction,
            ),
            proposal.evidence
              ? h(
                  'p',
                  { className: 'dsh-dot-block' },
                  h('b', null, `${t('evidence')}: `),
                  proposal.evidence,
                )
              : null,
            h(
              'p',
              { className: 'dsh-dot-text' },
              h('b', null, `${t('riskReason')}: `),
              proposal.riskReason,
            ),
            proposal.executionTools.length > 0
              ? h(
                  'div',
                  { className: 'dsh-dot-tools' },
                  ...proposal.executionTools.map((tool) =>
                    h('span', { key: tool, className: 'dsh-dot-chip' }, tool),
                  ),
                )
              : null,
            h(
              'div',
              { className: 'dsh-dot-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-dot-btn',
                  disabled: isBusy,
                  onClick: () => void decide(proposal, 'reject'),
                },
                t('reject'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-dot-btn primary',
                  disabled: isBusy,
                  onClick: () => void decide(proposal, 'approve'),
                },
                isBusy ? t('working') : t('approve'),
              ),
            ),
          )
        }

        function statusLabel(status: string | undefined, t: (key: string) => string) {
          if (status === 'running') return t('running')
          if (status === 'starting') return t('starting')
          if (status === 'error') return t('error')
          if (status === 'executed') return t('executedStatus')
          if (status === 'executing' || status === 'approved') return t('executingStatus')
          if (status === 'rejected') return t('rejectedStatus')
          if (status === 'failed') return t('failedStatus')
          if (status === 'pending') return t('pendingStatus')
          return t('idle')
        }

        function riskLabel(risk: string, t: (key: string) => string) {
          if (risk === 'high') return t('riskHigh')
          if (risk === 'medium') return t('riskMedium')
          return t('riskLow')
        }

        function formatTime(at: number): string {
          try {
            return new Date(at).toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })
          } catch {
            return ''
          }
        }

        function DotRail(props: {
          sessionId?: string
          t?: (key: string, vars?: Record<string, unknown>) => string
        }) {
          const t = props.t ?? tr
          const [state, setState] = React.useState<DotState | null>(null)
          const [busy, setBusy] = React.useState<string | null>(null)
          const [error, setError] = React.useState<string | null>(null)
          const [flash, setFlash] = React.useState<string | null>(null)

          React.useEffect(() => {
            let cancelled = false
            let timer: ReturnType<typeof setTimeout> | undefined
            const load = async () => {
              try {
                const next = (await railRequest('/dsh-dot/state')) as DotState
                if (!cancelled && next?.ok) {
                  setState(next)
                  setError(null)
                }
              } catch (cause) {
                if (!cancelled) {
                  setError(`${t('errorRead')} ${(cause as any)?.message ?? ''}`.trim())
                }
              } finally {
                if (!cancelled) timer = setTimeout(load, 2_000)
              }
            }
            void load()
            return () => {
              cancelled = true
              if (timer) clearTimeout(timer)
            }
          }, [])

          const openConversation = () => {
            const uiWorkspace = ctx.get?.('uiWorkspace')
            if (uiWorkspace?.openSession && state?.dotSessionId) {
              uiWorkspace.openSession(state.dotSessionId)
            } else {
              setError(t('railNoSession'))
            }
          }

          const openPanel = () => {
            try {
              ctx.get?.('layout')?.selectPanel?.('dsh-dot-plugin')
            } catch (cause) {
              setError(`${t('failed')}: ${(cause as any)?.message ?? String(cause)}`)
            }
          }

          const runNow = async () => {
            setBusy('run')
            setError(null)
            setFlash(null)
            try {
              const result = await railRequest('/dsh-dot/check', { reason: 'rail' })
              if (result?.state) setState(result.state)
              setFlash(result?.started ? t('running') : String(result?.reason ?? ''))
            } catch (cause) {
              setError(`${t('failed')}: ${(cause as any)?.message ?? String(cause)}`)
            } finally {
              setBusy(null)
            }
          }

          const decide = async (proposal: Proposal, decision: 'approve' | 'reject') => {
            setBusy(proposal.id)
            setError(null)
            setFlash(null)
            try {
              const result = await railRequest('/dsh-dot/decision', {
                proposalId: proposal.id,
                decision,
              })
              if (result?.state) setState(result.state)
              setFlash(decision === 'approve' ? t('approved') : t('rejected'))
            } catch (cause) {
              setError(`${t('failed')}: ${(cause as any)?.message ?? String(cause)}`)
            } finally {
              setBusy(null)
            }
          }

          const focusTask = async (taskId: string) => {
            setBusy(`focus:${taskId}`)
            setError(null)
            setFlash(null)
            try {
              const result = await railRequest('/dsh-dot/focus', { taskId })
              if (result?.state) setState(result.state)
              setFlash(t('focused'))
            } catch (cause) {
              setError(`${t('failed')}: ${(cause as any)?.message ?? String(cause)}`)
            } finally {
              setBusy(null)
            }
          }

          if (!state) {
            return h(
              'div',
              { className: 'dsh-dot-panel dsh-dot-rail' },
              h('style', { key: 'style' }, OPEN_DOT_CSS + RAIL_CSS),
              h('p', { className: 'dsh-dot-text' }, error ?? t('railLoading')),
            )
          }

          const pending = state.proposals.filter((proposal) => proposal.status === 'pending')
          const recent = state.proposals.filter((proposal) => proposal.status === 'executed').slice(0, 4)
          const focusedTask = state.tasks.find((task) => task.id === state.focusedTaskId) ?? state.tasks[0]
          return h(
            'div',
            { className: 'dsh-dot-panel dsh-dot-rail', 'data-dsh-dot-rail': '' },
            h('style', { key: 'style' }, OPEN_DOT_CSS + RAIL_CSS),
            h(
              'div',
              { className: 'dsh-dot-header' },
              h('span', { className: 'dsh-dot-mark', 'aria-hidden': true }, h(DotIcon, { size: 22, active: true })),
              h(
                'div',
                { className: 'dsh-dot-heading' },
                h('h1', { className: 'dsh-dot-title' }, t('title')),
                h(
                  'p',
                  { className: 'dsh-dot-subtitle' },
                  `${statusLabel(state.dotStatus, t)}${
                    state.lastResearchCompletedAt
                      ? ` · ${t('lastResearch')} ${formatTime(state.lastResearchCompletedAt)}`
                      : ''
                  }`,
                ),
              ),
            ),
            h(
              'div',
              { className: 'dsh-dot-head-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-dot-btn primary',
                  onClick: openConversation,
                  disabled: !state.dotSessionId,
                },
                t('openConversation'),
              ),
              h(
                'button',
                { type: 'button', className: 'dsh-dot-btn', onClick: () => void runNow(), disabled: busy !== null || state.dotStatus === 'running' },
                busy === 'run' ? t('working') : t('runNow'),
              ),
              h('button', { type: 'button', className: 'dsh-dot-btn', onClick: openPanel }, t('openPanel')),
            ),
            h(
              'div',
              { className: 'dsh-dot-summary' },
              h('span', null, h('b', null, pending.length), ` ${t('railPending')}`),
              h('span', null, `${t('tasks')}: ${state.tasks.length}`),
              h('span', null, `${t('schedules')}: ${state.schedules.length}`),
              h('span', null, `${t('triggers')}: ${state.triggers.length}`),
            ),
            error ? h('div', { className: 'dsh-dot-error', role: 'alert' }, error) : null,
            flash ? h('div', { className: 'dsh-dot-flash', role: 'status' }, flash) : null,
            h(
              'section',
              { className: 'dsh-dot-section' },
              h('h2', { className: 'dsh-dot-section-title' }, t('railPending')),
              pending.length === 0
                ? h('div', { className: 'dsh-dot-empty' }, t('railClear'))
                : pending.map((proposal) =>
                    h(
                      'article',
                      { key: proposal.id, className: 'dsh-dot-card' },
                      h(
                        'div',
                        { className: 'dsh-dot-row' },
                        h('span', { className: `dsh-dot-risk ${proposal.risk}` }, riskLabel(proposal.risk, t)),
                        h('span', { className: 'dsh-dot-source' }, proposal.actionType),
                      ),
                      h('h3', { className: 'dsh-dot-proposal-title' }, proposal.title),
                      proposal.taskId
                        ? h('p', { className: 'dsh-dot-note' }, `Task: ${state.tasks.find((task) => task.id === proposal.taskId)?.title ?? proposal.taskId}`)
                        : null,
                      h('p', { className: 'dsh-dot-text' }, proposal.description),
                      proposal.executionTools.length > 0
                        ? h(
                            'div',
                            { className: 'dsh-dot-tools' },
                            ...proposal.executionTools.map((tool) =>
                              h('span', { key: tool, className: 'dsh-dot-chip' }, tool),
                            ),
                          )
                        : null,
                      h(
                        'div',
                        { className: 'dsh-dot-actions' },
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsh-dot-btn',
                            disabled: busy === proposal.id,
                            onClick: () => void decide(proposal, 'reject'),
                          },
                          t('reject'),
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsh-dot-btn primary',
                            disabled: busy === proposal.id,
                            onClick: () => void decide(proposal, 'approve'),
                          },
                          busy === proposal.id ? t('working') : t('approve'),
                        ),
                      ),
                    ),
                  ),
            ),
            state.tasks.length > 0
              ? h(
                  'section',
                  { className: 'dsh-dot-section' },
                  h('h2', { className: 'dsh-dot-section-title' }, t('tasks')),
                  ...state.tasks.slice(0, 6).map((task) =>
                    h(
                      'div',
                      { key: task.id, className: 'dsh-dot-card dsh-dot-task-card', 'data-status': task.status },
                      h(
                        'div',
                        { className: 'dsh-dot-row' },
                        h('span', { className: `dsh-dot-task-status ${task.status}` }, task.status),
                        task.priority ? h('span', { className: 'dsh-dot-source' }, task.priority) : null,
                        task.workerId ? h('span', { className: 'dsh-dot-source' }, `worker ${task.workerId.slice(0, 12)}`) : null,
                      ),
                      h('h3', { className: 'dsh-dot-proposal-title' }, task.title ?? task.goal ?? 'Untitled task'),
                      h('p', { className: 'dsh-dot-text' }, task.plan ?? task.progress ?? ''),
                      task.nextAction ? h('p', { className: 'dsh-dot-note' }, task.nextAction) : null,
                      task.waitingFor ? h('p', { className: 'dsh-dot-note' }, `Waiting: ${task.waitingFor}`) : null,
                      task.blockedReason ? h('p', { className: 'dsh-dot-error' }, task.blockedReason) : null,
                      h(
                        'div',
                        { className: 'dsh-dot-actions' },
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsh-dot-btn',
                            disabled: busy === `focus:${task.id}`,
                            onClick: () => void focusTask(task.id),
                          },
                          state.focusedTaskId === task.id ? t('focused') : t('focus'),
                        ),
                      ),
                    ),
                  ),
                )
              : null,
            focusedTask
              ? h(
                  'section',
                  { className: 'dsh-dot-section' },
                  h('h2', { className: 'dsh-dot-section-title' }, t('taskDetail')),
                  h(
                    'div',
                    { className: 'dsh-dot-card' },
                    h('h3', { className: 'dsh-dot-proposal-title' }, focusedTask.title ?? focusedTask.goal ?? 'Untitled task'),
                    h('p', { className: 'dsh-dot-text' }, focusedTask.plan ?? focusedTask.progress ?? ''),
                    focusedTask.nextAction ? h('p', { className: 'dsh-dot-note' }, focusedTask.nextAction) : null,
                    focusedTask.verifiedResult ? h('p', { className: 'dsh-dot-flash' }, focusedTask.verifiedResult) : null,
                    h(
                      'div',
                      { className: 'dsh-dot-actions', style: { justifyContent: 'flex-start' } },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-dot-btn',
                          disabled: busy === `focus:${focusedTask.id}`,
                          onClick: () => void focusTask(focusedTask.id),
                        },
                        state.focusedTaskId === focusedTask.id ? t('focused') : t('focus'),
                      ),
                    ),
                    h('h4', { className: 'dsh-dot-section-title' }, t('artifacts')),
                    (focusedTask.artifacts ?? []).length > 0
                      ? h(
                          'div',
                          { className: 'dsh-dot-sources' },
                          ...(focusedTask.artifacts ?? []).map((artifact) =>
                            h('span', { key: artifact.id }, `${artifact.kind}: ${artifact.path ?? artifact.url ?? artifact.title}`),
                          ),
                        )
                      : h('p', { className: 'dsh-dot-note' }, t('noArtifacts')),
                    h('h4', { className: 'dsh-dot-section-title' }, t('activity')),
                    (focusedTask.events ?? []).slice(-5).reverse().map((event) =>
                      h(
                        'div',
                        { key: event.id, className: 'dsh-dot-recent' },
                        h('span', { className: 'dsh-dot-source' }, event.type),
                        h('span', { className: 'dsh-dot-recent-text' }, event.summary),
                        h('span', { className: 'dsh-dot-source' }, formatTime(event.at)),
                      ),
                    ),
                  ),
                )
              : null,
            h(
              'section',
              { className: 'dsh-dot-section' },
              h('h2', { className: 'dsh-dot-section-title' }, t('workers')),
              (state.workers ?? []).length > 0
                ? h(
                    'div',
                    { className: 'dsh-dot-card' },
                    ...(state.workers ?? []).slice(0, 6).map((worker) =>
                      h(
                        'div',
                        { key: worker.id, className: 'dsh-dot-recent' },
                        h('span', { className: `dsh-dot-task-status ${worker.status}` }, worker.status),
                        h('span', { className: 'dsh-dot-recent-text' }, worker.taskId),
                        h('span', { className: 'dsh-dot-source' }, worker.sessionId.slice(0, 18)),
                      ),
                    ),
                  )
                : h('div', { className: 'dsh-dot-empty' }, t('noWorkers')),
            ),
            state.schedules.length > 0
              ? h(
                  'section',
                  { className: 'dsh-dot-section' },
                  h('h2', { className: 'dsh-dot-section-title' }, t('schedules')),
                  h(
                    'div',
                    { className: 'dsh-dot-card' },
                    ...state.schedules.slice(0, 4).map((schedule) =>
                      h(
                        'div',
                        { key: schedule.id, className: 'dsh-dot-recent' },
                        h('span', { className: 'dsh-dot-recent-text' }, schedule.title),
                        h('span', { className: 'dsh-dot-source' }, schedule.detail),
                      ),
                    ),
                  ),
                )
              : null,
            state.triggers.length > 0
              ? h(
                  'section',
                  { className: 'dsh-dot-section' },
                  h('h2', { className: 'dsh-dot-section-title' }, t('triggers')),
                  h(
                    'div',
                    { className: 'dsh-dot-card' },
                    ...state.triggers.slice(0, 4).map((trigger) =>
                      h(
                        'div',
                        { key: trigger.id, className: 'dsh-dot-recent' },
                        h('span', { className: 'dsh-dot-recent-status' }, trigger.source),
                        h('span', { className: 'dsh-dot-recent-text' }, trigger.instruction),
                        h('span', { className: 'dsh-dot-source' }, trigger.condition),
                      ),
                    ),
                  ),
                )
              : null,
            recent.length > 0
              ? h(
                  'section',
                  { className: 'dsh-dot-section' },
                  h('h2', { className: 'dsh-dot-section-title' }, t('railRecent')),
                  h(
                    'div',
                    { className: 'dsh-dot-card' },
                    ...recent.map((proposal) =>
                      h(
                        'div',
                        { key: proposal.id, className: 'dsh-dot-recent' },
                        h('span', { className: 'dsh-dot-recent-status executed' }, t('executedStatus')),
                        h('span', { className: 'dsh-dot-recent-text' }, proposal.title),
                      ),
                    ),
                  ),
                )
              : null,
            state.sources.length > 0
              ? h(
                  'section',
                  { className: 'dsh-dot-section' },
                  h('h2', { className: 'dsh-dot-section-title' }, t('railSources')),
                  h(
                    'div',
                    { className: 'dsh-dot-sources' },
                    ...state.sources.map((source) =>
                      h('span', { key: source.id }, `${source.label} · ${source.kind}`),
                    ),
                  ),
                )
              : null,
            h('p', { className: 'dsh-dot-note' }, t('railHint')),
          )
        }

        function DotGateway() {
          const [error, setError] = React.useState<string | null>(null)
          React.useEffect(() => {
            let active = true
            const run = async () => {
              try {
                const next = (await railRequest('/dsh-dot/state')) as DotState
                const uiWorkspace = ctx.get?.('uiWorkspace')
                if (!active) return
                if (uiWorkspace?.openSession && next?.dotSessionId) {
                  uiWorkspace.openSession(next.dotSessionId)
                  return
                }
                setError(tr('railNoSession'))
              } catch (cause) {
                if (active) setError(`${tr('failed')}: ${(cause as any)?.message ?? String(cause)}`)
              }
            }
            void run()
            return () => {
              active = false
            }
          }, [])
          return h(
            'div',
            { className: 'dsh-dot-gateway' },
            h('style', { key: 'style' }, CHAT_CSS),
            h('span', { className: 'dsh-dot-gateway-mark' }, h(DotIcon, { size: 30, active: true })),
            h('p', null, error ?? tr('railLoading')),
          )
        }

        function DotPresence(props: {
          sessionId?: string
          t?: (key: string, vars?: Record<string, unknown>) => string
        }) {
          const t = props.t ?? tr
          const [state, setState] = React.useState<DotState | null>(null)
          React.useEffect(() => {
            let active = true
            let timer: ReturnType<typeof setTimeout> | undefined
            const load = async () => {
              try {
                const next = (await railRequest('/dsh-dot/state')) as DotState
                if (active) setState(next)
              } catch {
                // keep the last known state
              } finally {
                if (active) timer = setTimeout(load, 2_000)
              }
            }
            void load()
            return () => {
              active = false
              if (timer) clearTimeout(timer)
            }
          }, [])
          if (!state?.dotSessionId || String(state.dotSessionId) !== String(props.sessionId)) return null
          const busy = state.dotStatus === 'running'
          return h(
            'span',
            { className: 'dsh-dot-presence-wrap' },
            h('style', { key: 'style' }, CHAT_CSS + '[data-turn-process]{display:none!important}'),
            h(
              'span',
              { className: `dsh-dot-presence ${busy ? 'busy' : 'idle'}`, title: busy ? t('running') : t('title') },
              h('span', { className: 'dsh-dot-presence-dot', 'aria-hidden': true }),
              h('span', null, busy ? t('running') : t('title')),
            ),
          )
        }

        function DotHeaderAction(props: {
          sessionId?: string
          t?: (key: string, vars?: Record<string, unknown>) => string
        }) {
          const t = props.t ?? tr
          const [isDotSession, setIsDotSession] = React.useState<boolean | null>(null)
          React.useEffect(() => {
            let active = true
            let timer: ReturnType<typeof setTimeout> | undefined
            const check = async () => {
              try {
                const next = (await railRequest('/dsh-dot/state')) as DotState
                if (active) {
                  const mine = Boolean(next?.dotSessionId && String(next.dotSessionId) === String(props.sessionId))
                  setIsDotSession(mine)
                  if (!mine) return
                  timer = setTimeout(() => {
                    try {
                      ctx.sidebarRight.openTab(TAB_KIND)
                    } catch {
                      // The right sidebar may not have adopted this Session yet.
                    }
                  }, 350)
                }
              } catch {
                if (active) setIsDotSession(null)
              }
            }
            void check()
            return () => {
              active = false
              if (timer) clearTimeout(timer)
            }
          }, [props.sessionId])

          if (isDotSession !== true) return null
          return h(
            'button',
            {
              type: 'button',
              className: 'dsh-dot-header-action',
              title: t('title'),
              onClick: () => {
                try {
                  ctx.sidebarRight.openTab(TAB_KIND)
                } catch {
                  // ignore; the header is still mounted while the Session settles
                }
              },
            },
            h(DotIcon, { size: 15, active: true }),
            h('span', null, t('dotShort')),
          )
        }

        function DotFooterAction(props: {
          wide?: boolean
          t?: (key: string, vars?: Record<string, unknown>) => string
        }) {
          const t = props.t ?? tr
          const [busy, setBusy] = React.useState(false)
          const open = async () => {
            setBusy(true)
            try {
              const next = (await railRequest('/dsh-dot/state')) as DotState
              const uiWorkspace = ctx.get?.('uiWorkspace')
              if (uiWorkspace?.openSession && next?.dotSessionId) {
                uiWorkspace.openSession(next.dotSessionId)
                setTimeout(() => {
                  try {
                    ctx.sidebarRight.openTab(TAB_KIND)
                  } catch {
                    // The Session may still be settling; the header action can open it after mount.
                  }
                }, 500)
              }
            } catch {
              // no-op; the main panel exposes the current error
            } finally {
              setBusy(false)
            }
          }
          return h(
            'button',
            {
              type: 'button',
              className: 'dsh-dot-footer-action',
              disabled: busy,
              title: t('openConversation'),
              onClick: () => void open(),
            },
            h(DotIcon, { size: 17, active: true }),
            props.wide ? h('span', null, t('title')) : null,
          )
        }

        function DotTabTitle(props: {
          t?: (key: string, vars?: Record<string, unknown>) => string
        }) {
          const t = props.t ?? tr
          return h(
            'span',
            { className: 'dsh-dot-tab-title' },
            h(DotIcon, { size: 14, active: true }),
            h('span', null, t('title')),
          )
        }

        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: 'dsh-dot-presence',
              order: 10,
              locale: NS,
            },
            DotPresence,
          ),
        )

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'dsh-dot-plugin',
              order: 20,
              label: () => tr('title'),
            },
            DotIcon,
          ),
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: 'dsh-dot-plugin',
            },
            DotGateway,
          ),
        )

      },
    }
  },
})
