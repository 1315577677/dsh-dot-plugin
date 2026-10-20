# 001 — Implementation Plan

**Feature:** DSH Dot task orchestrator  
**Spec:** [spec.md](spec.md)  
**Status:** Draft for review  
**Target release:** `0.3.0`  
**Implementation mode:** incremental PRs on `main`, feature-flagged until acceptance

---

## 0. 中文摘要

这份计划把当前“Dot 自己研究、自己提案、等用户批准”的模式，重构为 OpenAI Dot 式的**任务协调层**：

- **Dot Supervisor**：常驻 Dot Agent，只负责接需求、建任务、派 worker、跟踪、沟通、请求决策；
- **Worker Agents**：每个任务一个独立 DSH Agent Session，拥有任务级工具权限和 staging 写入区；
- **Coordinator**：维护任务队列、并发上限、焦点切换和 worker 事件回流；
- **Task Store v2**：任务状态机、事件、产物、worker、焦点、审批关联，全部可恢复；
- **右栏任务工作台**：任务列表、当前任务、worker、产物、活动、审批；中间仍是真实 DSH 对话；
- **安全边界不变**：worker 不能批准自己，外部动作必须用户批准，研究默认只读。

MVP 先支持 **2 个并发任务 + 焦点切换 + 任务级审批 + 崩溃恢复**，不做云端电脑、Slack、语音、应用市场。共 10 步，关键路径：

`1 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10`

验收必须证明：两个真实任务可以交替推进、worker 真实存在、任务状态真实、没有未批准写入、重启后不出现假的 `running`。

---

## 1. Technical context

### Repository

- Project: `dsh-dot-plugin` (the repository checkout)
- Stack: TypeScript, ESM Host plugin, plain browser Client module, Node `node:test`
- Host entry: `src/host/index.ts`
- Current runtime: `src/host/runtime.ts`
- Current tools: `src/host/tools.ts`
- Current state: `src/host/state.ts`, `src/host/types.ts`
- Local bridge: `src/host/http.ts`
- Client: `src/client.ts`
- Tests: `test/core.test.mjs`
- Package/version: `dsh-dot-plugin@0.2.0`
- Git remote: `https://github.com/1315577677/dsh-dot-plugin.git`
- CI: `.github/workflows/ci.yml`

### Current implementation (v0.2.0)

- `DotRuntime` creates/resumes one persistent Dot Agent with the `standard` preset and scoped Dot tools.
- Legacy research is read-only: global `tools.restrict()` + scoped `tools.guard()`.
- The research heartbeat is legacy behavior; orchestrator mode replaces it with a coordinator tick and event-driven work.
- Proposals are action-level, reviewed by an independent small model, and approved only by the user.
- Any `DotTask` is a flat record: `{ id, goal, progress, nextStep, status }`.
- The Dot Agent itself does research and approved execution; there is no worker layer.
- The Client already has a native right rail tab, a header **Dot** action, and a sidebar footer action.
- The rail/panel currently read a single `/dsh-dot/state` snapshot.

### Relevant DSH capabilities

Verified from the live Harness API:

- `ctx.agents.create()` / `ctx.agents.resume()` create/resume separate Agent Sessions.
- `CreateAgentOptions` supports `parentAgent`, `meta.cwd`, `meta.parentSession`, `meta.origin: 'subagent'`, `meta.agentPreset`, `agentOptions`, and `setup`.
- `agentPresets.mount(agentCtx, 'standard')` supplies the real read/edit/read-only/web tools.
- `agentCtx.on('agent/status', …)` reports idle/running transitions.
- `agent.followup(message)` starts another turn; `agent.inject(message)` adds context.
- `agent.session.snapshotEvents()` exposes the Agent's real event log.
- `tools.restrict()` / `tools.guard()` can scope tools and tool arguments.
- `ctx.schedule` is the durable DSH schedule service.
- The Client right sidebar tab API is `ctx.sidebarRightTabs.register()` + `sidebar.right.pane.tab` keyed by the tab **type id**, not the kind.
- `ctx.sidebarRight.openTab(kind)` opens a registered page tab.

### Constraints

- Desktop Client bundles require a full app restart.
- Node 22+; pnpm 11; CI uses pnpm 11.
- Worktree is `danger-full-access`; the plugin must still enforce its own boundaries.
- Existing data in `data/state.json` must be migrated, not discarded.
- Do not intercept the user's normal Sessions.
- Default concurrency: 2 workers.

---

## 2. Constitution check

| Principle | Design response |
| --- | --- |
| Read-only first | Workers get read/web tools; writes only to per-task staging until approval |
| User-only approval | Workers and supervisor cannot approve; panel/`/dot` remain the only approval surfaces |
| Scoped execution | Per-task worker allowlist + per-proposal execution allowlist |
| Durable state | State v2 with tasks, events, workers, artifacts, focus; atomic writes |
| No global hijack | All guards live in supervisor/worker Agent scopes |
| No fake capability | UI uses real workers/connectors; no computer/Slack imitation |
| Small PRs | Ten independently verifiable steps |
| Test state machine | Unit tests for transitions, concurrency, recovery, migration |

**Gate:** no step may weaken any of these without updating the spec and obtaining explicit user approval.

---

## 3. Architecture

```text
┌────────────────────────────────────────────────────────────────────┐
│ DSH Host                                                           │
│                                                                    │
│  ┌─────────────────────┐      events       ┌────────────────────┐  │
│  │ Dot Supervisor      │◀──────────────────│ Coordinator        │  │
│  │ persistent Agent    │                   │ queue + pump       │  │
│  │ manager prompt      │──────────────────▶│ worker status      │  │
│  │ task tools          │  assign/continue  │ focus/priority     │  │
│  └─────────┬───────────┘                   └─────────┬──────────┘  │
│            │                                         │             │
│            │ creates/continues                       │ creates     │
│            ▼                                         ▼             │
│  ┌─────────────────────┐                   ┌────────────────────┐  │
│  │ Task Store v2       │                   │ Worker Manager     │  │
│  │ tasks/events/       │                   │ Agent per task     │  │
│  │ workers/artifacts   │                   │ staging writes     │  │
│  └─────────┬───────────┘                   └─────────┬──────────┘  │
│            │                                         │             │
│            └──────────────┬──────────────────────────┘             │
│                           ▼                                        │
│                  ┌──────────────────┐                              │
│                  │ Approval/        │                              │
│                  │ Execution        │                              │
│                  │ user-only        │                              │
│                  └──────────────────┘                              │
│                                                                    │
│  HTTP bridge: /dsh-dot/state, /dsh-dot/focus, /dsh-dot/decision   │
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│ DSH Client                                                         │
│  Dot conversation (center) + right rail:                           │
│  tasks / focused task / workers / approvals / outputs / activity   │
└────────────────────────────────────────────────────────────────────┘
```

### Component responsibilities

#### Dot Supervisor

- One persistent Agent/Session, title `Dot`.
- Manager persona, not a worker persona.
- Owns task intake and task state mutations.
- Delegates substantial work to workers.
- Receives worker events and decides next action.
- Produces user-facing milestone messages in the Dot conversation.
- Creates proposals for user-approved actions.
- Never silently approves or executes.

#### Coordinator

- Runs a maintenance tick every `coordinatorIntervalMs` (pump, timeouts, reconciliation).
- Serializes task-state mutations and worker events.
- Maintains the worker queue and concurrency cap.
- Starts/continues/cancels workers.
- Wakes the supervisor when a worker completes, fails, times out, or needs input.
- Handles focus and priority selection.
- Owns retry/recovery decisions at the orchestration level.

#### WorkerManager

- Talks to a small `WorkerAgentPort` adapter (`create`, `followup`, `status`, `dispose`, `result`); the real adapter wraps `ctx.agents`, and tests use a fake.
- Creates/resumes one worker Agent per task.
- Injects the task brief and a manager-controlled continuation message.
- Applies the worker tool policy and staging path guard.
- Captures worker result/events.
- Exposes worker status for the UI.
- Disposes/cancels workers safely.

#### TaskStore

- Durable v2 state; atomic writes.
- Task history, workers, artifacts, focus, proposals link.
- Migration from v1.
- Snapshot for Client.

#### Approval/Execution

- Reuses the existing independent reviewer and proposal store.
- Adds `taskId`/`workerId` to proposals.
- User-only decisions via panel/rail/`/dot`.
- Execution runs in a scoped turn; result/failure becomes a task event and wakes the supervisor.
- Does not give the worker approval authority.

---

## 4. Data model (state v2)

```ts
type TaskStatus =
  | 'inbox'
  | 'planned'
  | 'running'
  | 'coordinating'
  | 'waiting_user'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'cancelled'

type TaskPriority = 'low' | 'normal' | 'high'

interface TaskArtifact {
  id: string
  title: string
  path?: string
  url?: string
  kind: 'file' | 'link' | 'report' | 'draft'
  createdAt: number
}

interface TaskEvent {
  id: string
  at: number
  actor: 'dot' | 'worker' | 'user' | 'system'
  type:
    | 'created'
    | 'planned'
    | 'worker_started'
    | 'worker_progress'
    | 'worker_completed'
    | 'worker_failed'
    | 'worker_cancelled'
    | 'decision_requested'
    | 'approved'
    | 'rejected'
    | 'executed'
    | 'blocked'
    | 'resumed'
    | 'completed'
    | 'cancelled'
  summary: string
  detail?: string
  proposalId?: string
  artifactId?: string
}

interface DotTaskV2 {
  id: string
  title: string
  request: string
  status: TaskStatus
  priority: TaskPriority
  createdAt: number
  updatedAt: number
  workerId?: string
  plan: string
  nextAction: string
  waitingFor?: string
  blockedReason?: string
  artifacts: TaskArtifact[]
  events: TaskEvent[]
  proposalIds: string[]
  verifiedResult?: string
  legacy?: true
}

interface WorkerRecord {
  id: string
  taskId: string
  sessionId: string
  status: 'starting' | 'running' | 'idle' | 'completed' | 'failed' | 'cancelled'
  brief: string
  startedAt: number
  updatedAt: number
  lastResult?: string
  lastError?: string
  turns: number
}

interface DotStateV2 {
  version: 2
  dotSessionId?: string
  tasks: DotTaskV2[]
  workers: WorkerRecord[]
  focusedTaskId?: string
  proposals: Proposal[]        // gains taskId/workerId
  triggers: DotTrigger[]
  lastResearchAt?: number
  lastResearchCompletedAt?: number
  lastError?: string
  pendingAuto: string[]
  executingId?: string
}
```

### State transitions

```text
inbox
  └─▶ planned ──▶ running ──▶ coordinating ──▶ running ──▶ done
         │            │             │              │
         │            │             ├─▶ waiting_user
         │            │             ├─▶ blocked
         │            │             └─▶ failed
         │            └─▶ cancelled
         └─▶ cancelled
```

- `focusedTaskId` is independent of status; focusing does not pause other tasks.
- After a worker idle event, the task becomes `coordinating`; no worker is running. The supervisor then moves it to `running`, `waiting_user`, `blocked`, `done`, or `failed`.
- One task has at most one active worker (`running`/`starting`).
- `waiting_user` means no worker is consuming turns; the task is parked on a decision.
- `blocked` has a `blockedReason`; `interrupted` is represented as `blocked` with reason `interrupted`.
- A task cannot be `done` without at least one artifact or a verified result string.

### Migration v1 → v2

- Set `state.version = 2`.
- Every existing `DotTask` becomes a `DotTaskV2` with:
  - `title = goal`
  - `request = goal`
  - `status = 'done'` for legacy done tasks, otherwise `'blocked'` with `blockedReason = 'legacy_task_needs_adoption'`
  - `plan = progress`
  - `nextAction = nextStep`
  - `verifiedResult = progress` for legacy done tasks
  - one `created` event and one status event
- Existing proposals keep their current shape; add `taskId` only when known.
- `focusedTaskId` = first non-done legacy task, if any.
- Store a one-time backup copy `data/state.v1.backup.json` before writing v2.
- The first supervisor turn must adopt legacy tasks explicitly; it must not pretend they have workers.

---

## 5. Supervisor design

### Prompt sections

1. **Identity:** You are DSH Dot, the user's task coordinator.
2. **Operating loop:** intake → task → plan → assign worker → track → report → decide → close.
3. **Communication rules:** concise, first person, evidence, one decision per turn, say what was not done.
4. **Delegation rules:** don't do substantial work yourself; use workers; keep task state current.
5. **Safety rules:** no self-approval; no external sends; no raw logs; no invented progress.
6. **Task focus rules:** current focus is a priority, not exclusivity.

The prompt must not include the old “research sources and propose actions” instructions as the primary job. Research becomes a worker capability.

### Supervisor tools

The supervisor keeps read-only inspection tools only; apply a global `tools.restrict` allowlist that excludes `write`, `edit`, and `bash`. Approved execution is a separate scoped turn that temporarily grants only the proposal's execution tools; it is never a general supervisor capability.

| Tool | Purpose |
| --- | --- |
| `dot_create_task` | Create a task from a user request |
| `dot_update_task` | Update status/plan/next action/waiting/blocker |
| `dot_list_tasks` | Read task summaries and focus |
| `dot_task_detail` | Read one task's events/artifacts/worker |
| `dot_assign_worker` | Start a worker for a planned task with a brief |
| `dot_continue_worker` | Send the next instruction to an existing worker for a task |
| `dot_focus_task` | Set the user's focused task |
| `dot_attach_artifact` | Attach a real output (staging artifact or approved result) to a task |
| `dot_propose_action` | Create a task-linked approval proposal |
| `dot_complete_task` | Close a task only with evidence/artifact |
| `dot_schedule_task` | Existing schedule tool |
| `dot_register_trigger` | Existing trigger tool |

`dot_update_task` and `dot_complete_task` are intentionally separate: completion requires evidence.

### Communication policy

A user-facing update should contain:

```text
Task: <name> — <status>

<one or two sentences: what happened / what was found>

Decision: <exact action>?   (only when needed)
Not done yet: <explicit boundary>   (when relevant)
```

The supervisor should avoid:

- raw event dumps;
- “I will investigate” followed by silence;
- claiming completion without a result;
- asking multiple unrelated questions;
- doing the worker's detailed work in the chat.

---

## 6. Worker design

> **Tool boundary:** workers do not receive the generic `write`/`edit` tools. Staging files are created through the plugin-owned, path-guarded `dot_stage_file` tool so a worker cannot trigger a DSH approval prompt or escape the staging directory. Real-target writes happen only in the approved execution turn.

### Worker creation

```ts
const handle = await ctx.agents.create({
  sessionId: `session-dot-worker-${randomUUID()}`,
  parentAgent: supervisor.agent,
  meta: {
    cwd: taskWorkspace,
    parentSession: supervisor.sessionId,
    origin: 'subagent',
    agentPreset: config.workerPreset,
  },
  setup: (workerCtx, worker) => configureWorker(workerCtx, worker, task),
})
```

`configureWorker`:

- mount `standard` preset;
- apply a global `tools.restrict` allowlist: `read`, `glob`, `grep`, `web_search`, `web_fetch`, `dot_worker_report`, `dot_stage_file` (no `write`/`edit`/`bash`);
- add `dsh-dot:worker` prompt section with the task brief;
- register only `dot_worker_report` and `dot_stage_file`; no task-management or proposal tools;
- apply a guard:
  - allow `read`, `glob`, `grep` only under `workerReadRoots` (task cwd + configured directory sources);
  - allow `web_search`, `web_fetch`;
  - allow `dot_stage_file` only under `<workspace>/.dsh-dot/staging/<taskId>/`;
  - do **not** expose generic `write`, `edit`, or `bash` to workers;
  - deny everything else, including external actions.
- attach `agent/status` listener for idle;
- do not allow approvals, task mutation, or proposal creation.

### Worker brief

```text
You are a worker for DSH Dot.

Task: <title>
Request: <user request>
Goal for this turn: <brief>
Workspace: <cwd>
Staging: <cwd>/.dsh-dot/staging/<taskId>/

Rules:
- Read-only research is allowed.
- Use `dot_stage_file` to create files under the staging directory.
- Do not use generic write/edit/bash, and never send, publish, delete, or modify files outside staging.
- Report progress through dot_worker_report.
- End with a concise result: what you did, evidence, outputs, and what remains.
```

### Worker lifecycle

```text
create
  → starting
  → running (followup brief)
  → idle/completed
      → WorkerManager captures result
      → TaskEvent(worker_completed/progress)
      → Coordinator wakes supervisor
  → failed/timeout
      → TaskEvent(worker_failed)
      → Coordinator wakes supervisor
  → cancelled
      → TaskEvent(worker_cancelled)
```

- One worker per task.
- Max 2 active workers.
- Worker timeout default 15 minutes; max follow-up rounds 3.
- Worker status and result are persisted.
- On Host restart, workers are reconciled; a live worker without an Agent is `blocked/interrupted`, not `running`.

### Writes and promotion

- Worker writes go through `dot_stage_file` to `.dsh-dot/staging/<taskId>/`; the tool rejects traversal, symlinks, absolute paths outside staging, and oversized payloads.
- The supervisor can attach staging artifacts to the task without approval.
- Promoting a staged file to a real workspace path requires a proposal with `executionTools: ['write']` and the exact target.
- The execution instruction must include source staging path, target path, and verification.
- After approval, the execution turn writes the target and attaches the artifact.
- No worker can write to the real target directly; no generic write/edit/bash is exposed to workers.

---

## 7. Event and coordination loop

```text
1. User message in Dot Session
   → supervisor turn
   → create/update task
   → assign worker if work is ready

2. Worker idle/failure
   → WorkerManager captures result
   → TaskStore append event
   → Coordinator enqueues supervisor event

3. Supervisor event
   → supervisor followup:
     "[worker event] task T, worker W, status, result..."
   → supervisor updates task, reports to user, decides next

4. User approves/rejects
   → proposal status change
   → approved: execution turn
   → executed/failed: task event
   → wake supervisor

5. User asks about another task
   → supervisor reads task state
   → updates focus
   → replies, leaves other workers running
```

### Queue and concurrency

- `Coordinator.pump()` runs after: task created, worker idle/failed, approval decided, user focus change, startup.
- Order: focused task first, then `high` priority, then `planned` oldest.
- A task in `coordinating`, `waiting_user`, or `blocked` does not occupy a worker slot.
- `pump()` is serialized by a promise/mutex.
- If the supervisor is running, worker events are queued; flush after it goes idle.
- Duplicate worker creation is prevented by a per-task lock and a persisted `workerId`.

---

## 8. Approval and execution changes

- `Proposal` gains `taskId?: string` and `workerId?: string`.
- `dot_propose_action` accepts an optional `task_id`; if present, the task must exist.
- Approval UI shows the task title and link.
- Execution result is appended to the task as an `executed`/`failed` event; the task moves to `coordinating` for supervisor review.
- `/dot status` shows task summaries; `/dot approve|reject` shows the task title when linked.
- The supervisor is woken with the result; it decides:
  - task done;
  - next worker step;
  - another proposal;
  - blocked/user input.
- Existing `pendingAuto`, `executingId`, and `reconcileInterruptedExecution()` are reused.
- Execution remains task-scoped; the worker has no approval authority.

---

## 9. UI plan

### Right rail (`sidebar.right.pane.tab`, tab kind `dsh-dot`)

Sections:

1. **Dot header**: status, last activity, focused task.
2. **Tasks**: status dot, title, worker indicator; click → `POST /dsh-dot/focus`.
3. **Focused task detail**: plan, next action, blocked/waiting reason, worker status.
4. **Approvals**: task-linked proposals; approve/reject.
5. **Workers**: real worker sessions/status; no fake computer.
6. **Outputs**: artifacts with file/link.
7. **Activity**: latest task events, not raw logs.
8. **Sources/connectors**: configured sources; optional MCP connectors.

### Full panel

- Same data, larger layout.
- Task board by status.
- Task detail with events/artifacts.
- Focus control.
- Existing proposals/schedules/triggers sections remain.

### Header/footer actions

- Existing conversation-header **Dot** action opens the rail.
- Existing sidebar footer **DSH Dot** action opens the Dot Session.
- Add a task-focus action in the rail; no new global navigation.

### UI freshness

- Poll `/dsh-dot/state` every 2 seconds while any task is `running` or `waiting_user`; 5 seconds while idle.
- No push channel in the MVP; the 2-second target is for state that already exists.

### UI truthfulness

- `running` = an actual worker Agent or an approved execution turn is active; the rail shows which.
- `coordinating` = a worker returned and Dot is reviewing; no worker is running.
- `waiting_user` = parked for a decision.
- `blocked` = has a reason.
- No “computer”, “Slack”, or “call” labels unless a real connector exists.

---

## 10. HTTP/API changes

Existing:

- `GET /dsh-dot/health`
- `GET /dsh-dot/state`
- `POST /dsh-dot/check` (orchestrator tick; legacy research only when disabled)
- `POST /dsh-dot/decision`
- `POST /dsh-dot/trigger`

Add:

- `POST /dsh-dot/focus` `{ taskId }`
- `GET /dsh-dot/tasks` (optional convenience)
- `GET /dsh-dot/tasks/:id`
- `POST /dsh-dot/tasks/:id/cancel` (supervisor/user command; optional for MVP)
- `GET /dsh-dot/workers` (diagnostics)

All POST routes require `x-dsh-dot: 1`; same-origin/Origin checks remain.

`/dsh-dot/state` response adds:

```ts
{
  ...existing,
  focusedTaskId?: string,
  tasks: DotTaskV2[],
  workers: WorkerRecord[],
  taskEvents: TaskEvent[],   // optional recent slice
}
```

---

## 11. Configuration additions

| Key | Default | Purpose |
| --- | --- | --- |
| `orchestrator` | `false` | Enable the new supervisor/worker model; flip after Step 10 acceptance and keep the legacy path during the build |
| `maxWorkers` | `2` | Concurrent worker cap |
| `workerPreset` | `standard` | DSH preset for workers |
| `workerWriteMode` | `staging` | `staging` or `none` |
| `workerStageMaxBytes` | `1048576` | Max size of one staged artifact |
| `workerReadRoots` | task cwd + directory sources | Read/glob/grep allowlist roots for workers |
| `workerTimeoutMs` | `900000` | Worker turn timeout |
| `workerMaxTurns` | `3` | Follow-up rounds per task |
| `coordinatorIntervalMs` | `5000` | Orchestrator maintenance tick (pump/timeouts/reconcile) |
| `supervisorModel` | current | Optional model override |
| `workerModel` | current | Optional model override |
| `maxTasks` | `50` | Retention cap |
| `taskEventLimit` | `100` | Events kept per task |

Existing `readOnlyTools`, `executionTools`, `sources`, `rules`, `autoApproveLowRisk`, schedules/triggers remain. In orchestrator mode `researchIntervalMs` is ignored; `POST /dsh-dot/check` runs a coordinator tick rather than a research round.

---

## 12. Testing strategy

### Unit

- Task state machine transitions and invariants.
- v1 → v2 migration, including corrupt/partial state.
- Focus/priority selection and concurrency cap.
- Worker event deduplication and supervisor queue.
- Proposal task link and execution result routing.
- Worker path guard for staging vs real target.

### Integration

- A fake AgentFactory/worker that returns scripted events:
  - worker_started → progress → completed;
  - failure/timeout;
  - restart reconciliation.
- Two tasks in parallel; focus switch; no cross-task state corruption.
- Approval before write; target unchanged before approval; changed after.

### Manual/E2E

- Real DSH session with two tasks and a real read-only source.
- Right rail task focus, approvals, outputs, worker status.
- Restart Desktop, confirm recovery.
- No unapproved write/send.

### CI

- `pnpm typecheck`
- `pnpm build`
- `pnpm test`
- Existing CI workflow must stay green.

---

## 13. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Runaway worker cost/loops | Concurrency cap, timeout, max turns, cancel |
| State races | Single coordinator mutex, atomic store, per-task lock |
| Worker writes wrong path | Plugin-owned `dot_stage_file`; staging-only path guard; promotion via user approval |
| Duplicate workers after restart | Persisted workerId, reconciliation, per-task lock |
| Supervisor does worker's job | Prompt + tool separation; tests assert worker events |
| UI shows false “running” | Derive status from live worker handle; reconcile |
| Migration loses old tasks | Backup, explicit legacy adoption, tests |
| DSH agent API changes | Isolate in `WorkerManager`; contract tests |
| User loses trust from verbosity | Communication policy + acceptance review |
| Too many tasks overwhelm | Max tasks, archive/cancel in v0.4 |
| Approval bypass | No approval tool registered; security tests |

---

## 14. Rollout

1. Implement behind `orchestrator: true` feature flag; keep `legacy` research path available.
2. Merge step PRs to `main`; CI green.
3. Run a local acceptance with two tasks.
4. Migrate the live state with backup.
5. Release `v0.3.0`; update README/release notes.
6. Desktop restart for the Client bundle.

Rollback:

- Disable `orchestrator` and restart Host.
- Restore `data/state.v1.backup.json` if migration fails.
- Existing Dot session/proposals remain readable.

---

## 15. Project structure changes

```text
src/host/
├── index.ts                 # config, service, bridge wiring
├── types.ts                 # TaskV2, WorkerRecord, events, snapshot
├── state.ts                 # v2 migration, backup, atomic writes
├── orchestrator/
│   ├── supervisor.ts        # supervisor prompt/tools
│   ├── worker-manager.ts    # worker Agent lifecycle
│   ├── coordinator.ts       # queue, pump, focus, events
│   ├── tasks.ts             # domain operations
│   └── tools.ts             # supervisor/worker tools
├── runtime.ts               # compatibility facade / approval execution
├── reviewer.ts              # unchanged
├── http.ts                  # focus/tasks/workers routes
└── tools.ts                 # legacy tools moved/extended

src/client.ts                # rail/panel task workspace
test/
├── task-state.test.mjs
├── orchestrator.test.mjs
├── coordinator.test.mjs
└── core.test.mjs
```

Prefer adding new modules over growing `runtime.ts`; keep a facade so the existing panel/HTTP endpoints do not break mid-refactor.

---

## 16. Step plan (summary)

Detailed steps, context briefs, verification, and exit criteria are in [tasks.md](tasks.md).

| Step | Deliverable | Depends on | Parallel with |
| --- | --- | --- | --- |
| 1 | Task model v2 + migration + state tests | — | — |
| 2 | Supervisor task tools + manager prompt | 1 | 3 |
| 3 | WorkerManager + worker lifecycle + event loop | 1 | 2 |
| 4 | Task-scoped proposals + approval/execution routing | 2, 3 | — |
| 5 | Coordinator queue/focus/concurrency + two workers | 3, 4 | — |
| 6 | Right rail/panel task workspace + focus API | 5 | — |
| 7 | Human-like communication policy + single-task E2E | 4, 5, 6 | — |
| 8 | Recovery/cancel/timeout/failure isolation | 7 | — |
| 9 | Schedules/triggers → tasks + docs | 2, 5, 8 | — |
| 10 | Two-task acceptance + v0.3.0 release | all | — |

**Critical path:** 1 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10.

---

## 17. Definition of done

- Spec acceptance scenarios AT-1 through AT-7 pass.
- A real task creates a worker, produces evidence, asks for approval, writes a real file, and closes.
- A second task runs concurrently; focus switches without cancelling either.
- No unapproved write/send.
- Restart recovery does not leave a false `running`.
- Right rail shows real task/worker/activity/output data.
- CI green; README documents the orchestrator and migration.
- User reviews and explicitly accepts the behavior.

---

## 18. Plan mutation protocol

- **Split** a step when it exceeds one PR or contains two unrelated risks.
- **Insert** a step only if it is a prerequisite for an existing step; update all dependencies.
- **Skip** a step only with a written reason and a replacement verification.
- **Reorder** only within the same dependency layer.
- Record every mutation in `tasks.md` under “Plan changes” with date/reason.
- Re-run the adversarial review after any critical-path change.

---

## 19. Review checklist (for the plan review)

- Does every requirement map to a step?
- Is the supervisor/worker split real, not prompt-only?
- Can a worker write outside staging? Is the guard testable?
- Is user-only approval preserved end-to-end?
- Are two tasks genuinely concurrent and focus-switchable?
- Is restart recovery defined for workers, proposals, and tasks?
- Are migration and rollback safe?
- Are UI states truthful?
- Are tests able to run without a live LLM?
- Is the critical path realistic and small enough for PRs?
