# 001 — Step-by-Step Tasks

**Feature:** DSH Dot task orchestrator  
**Spec:** [spec.md](spec.md)  
**Plan:** [plan.md](plan.md)  
**Status:** Draft for review  
**Target:** `v0.3.0`

---

## How to execute this plan

- One step per branch/PR unless the step explicitly says otherwise.
- Branch naming: `feat/orchestrator-<step>-<slug>`.
- Every PR runs: `pnpm typecheck`, `pnpm build`, `pnpm test`.
- If a step changes behavior described in `spec.md`, update the spec in the same PR.
- Never wipe `data/state.json`; use migration + backup.
- Do not implement the next step while the current step's exit criteria are unmet.
- Keep `orchestrator: false` working until Step 10 acceptance.
- The current live profile may be on `0.2.0`; do not force a Desktop restart for every code step.

**Definition of done for every step:**

- code + tests + docs updated;
- no unrelated changes;
- CI green;
- verification commands recorded;
- rollback path clear;
- no weakening of read-only/user-approval boundaries.

---

## Step 1 — Task domain model v2 + migration

**Goal:** Replace the flat `DotTask` with a durable, eventful task record and migrate existing state without data loss.

**Depends on:** none  
**Parallel with:** none  
**Model tier:** strongest

### Context brief

Current types are in `src/host/types.ts`. `DotTask` is `{ id, goal, progress, nextStep, status }`. `DotState` is version 1. `StateStore` in `src/host/state.ts` writes atomically and has tests in `test/core.test.mjs`.

The new task model must support status, priority, worker reference, artifacts, events, focus, and legacy migration. Do not add worker behavior in this step.

### Tasks

- [ ] Add types: `TaskStatus` (including `coordinating`), `TaskPriority`, `TaskArtifact`, `TaskEvent`, `DotTaskV2`, `WorkerRecord`, `DotStateV2`, `ClientStateV2`.
- [ ] Add state version 2; keep a read path for version 1.
- [ ] Migrate v1 tasks to `DotTaskV2` with `status: 'blocked'`, `blockedReason: 'legacy_task_needs_adoption'`, and `legacy: true`.
- [ ] Write `data/state.v1.backup.json` before the first v2 write.
- [ ] Add `focusedTaskId`; default to the first non-done legacy task.
- [ ] Add task event append helpers; enforce monotonic `updatedAt`.
- [ ] Add invariants: one active worker per task; no `done` without artifact/verified result; valid status transitions.
- [ ] Update `ClientState` and the current client task rendering (`task.title ?? task.goal`) so the panel still builds during migration.
- [ ] Add `verifiedResult?: string` and enforce the completion guard on it or an artifact.
- [ ] Add tests:
  - v1 → v2 migration preserves pending proposals/tasks;
  - corrupt/partial state still falls back safely;
  - backup is created once;
  - focus survives reload;
  - invalid transition is rejected.
- [ ] Update `test/core.test.mjs` or add `test/task-state.test.mjs`.

### Files

- `src/host/types.ts`
- `src/host/state.ts`
- `src/client.ts` (compatibility only)
- `test/task-state.test.mjs` (new)
- `test/core.test.mjs` (adjust)

### Verification

```bash
pnpm typecheck
pnpm build
pnpm test
```

Manual: copy a v1 state fixture into a temp dir; load; confirm version 2, backup, legacy task, pending proposal.

### Exit criteria

- Existing tests pass.
- A v1 state migrates exactly once, with backup.
- No worker/agent code added yet.
- The panel still renders using the compatibility fields.

### Rollback

Revert the PR; restore `data/state.v1.backup.json` only if a manual migration was run. The old code must still read v1 state.

---

## Step 2 — Supervisor identity, prompt, and task tools

**Goal:** Make the Dot Agent a manager that can create/read/update/focus tasks; remove the old “research and propose” instructions as the primary job.

**Depends on:** Step 1  
**Parallel with:** Step 3 (expect `runtime.ts` merge coordination)  
**Model tier:** strongest

### Context brief

`src/host/runtime.ts` currently mounts the Dot Agent and registers research tools in `src/host/tools.ts`. The persona is a research prompt. The Agent has `followup`, `inject`, `session.snapshotEvents`, and `agent/status`.

This step adds the supervisor role and task tools. Worker assignment is a stub until Step 3; `dot_assign_worker` should return `worker_layer_not_ready` rather than silently doing work.

### Tasks

- [ ] Create `src/host/orchestrator/supervisor.ts` with the manager persona and task-communication policy.
- [ ] Create `src/host/orchestrator/tools.ts` with:
  - `dot_create_task`;
  - `dot_update_task`;
  - `dot_list_tasks`;
  - `dot_task_detail`;
  - `dot_focus_task`;
  - `dot_attach_artifact` (staging only);
  - `dot_complete_task` (requires evidence/artifact);
  - `dot_assign_worker` and `dot_continue_worker` stubs returning `worker_layer_not_ready`.
- [ ] Keep `dot_propose_action`, schedules, triggers for later integration.
- [ ] Remove or deprecate the legacy `dot_add_task`/`dot_update_task`/`dot_list_state` registrations; do not register duplicate tool names. Keep compatibility wrappers only if the old panel/command needs them.
- [ ] Register the supervisor prompt section instead of the research-only persona.
- [ ] Ensure `dot_create_task` is idempotent for the same request within a short window (avoid duplicate task creation on retry).
- [ ] Ensure task mutation is serialized through `TaskStore`.
- [ ] Add tests for task creation, update, focus, completion guard, and duplicate-request guard.
- [ ] Add a “manager prompt” test/assertion that the supervisor prompt contains delegation and no-self-approval rules.

### Files

- `src/host/orchestrator/supervisor.ts` (new)
- `src/host/orchestrator/tools.ts` (new)
- `src/host/runtime.ts`
- `src/host/tools.ts`
- `test/orchestrator.test.mjs` (new)

### Verification

```bash
pnpm typecheck
pnpm build
pnpm test
```

Manual: invoke `/dsh-dot/state`; verify tasks can be created through a synthetic supervisor turn (test harness, not a live LLM).

### Exit criteria

- The Dot Agent has task tools and a manager prompt.
- No task can be completed without evidence.
- No worker is started in this step.
- The old proposal/approval path still works.

### Rollback

Feature flag `orchestrator: false` restores the old research prompt/tools; revert otherwise.

---

## Step 3 — WorkerManager + worker Agents + event loop

**Goal:** Start a real worker Agent for a task, scope its tools, capture its result, and send an event back to the supervisor.

**Depends on:** Step 1  
**Parallel with:** Step 2 (expect `runtime.ts` merge coordination)  
**Model tier:** strongest

### Context brief

`ctx.agents.create()`/`resume()` are available; `agentPresets.mount()` supplies the standard preset; `agentCtx.on('agent/status')` reports idle. The current runtime already creates the Dot Agent this way.

Workers are child Agents of the supervisor. They must not share the supervisor's tool context. Use `meta.origin: 'subagent'`, `meta.parentSession`, `meta.cwd`, and a `setup` callback.

### Tasks

- [ ] Add `src/host/orchestrator/worker-manager.ts` with a `WorkerAgentPort` adapter; real adapter wraps `ctx.agents`, fake adapter for tests.
- [ ] Implement `spawn(task, brief)`:
  - create session `session-dot-worker-<uuid>`;
  - mount `standard` preset;
  - add the worker prompt;
  - register `dot_worker_report` and `dot_stage_file`;
  - do not expose generic `write`/`edit`/`bash`;
  - persist `WorkerRecord`;
  - send the brief with `followup`.
- [ ] Implement idle handling:
  - capture the assistant result from the turn start;
  - append `worker_progress`/`worker_completed`/`worker_cancelled` event;
  - update worker status;
  - set task `coordinating` when the worker returns and no further turn is immediately queued;
  - emit a coordinator event.
- [ ] Implement failure/timeout/cancel handling (basic in this step; hardened in Step 8), including worker creation failure and a task `blocked` reason.
- [ ] Implement `resume(task)` for an existing worker session; prevent duplicate workers.
- [ ] Replace the `dot_assign_worker`/`dot_continue_worker` stubs with WorkerManager calls; coordinator pump wiring remains Step 5.
- [ ] Implement `continue(workerId, message)` for a new worker turn; enforce `workerMaxTurns`.
- [ ] Ignore worker idle events before the first brief is delivered; mark `starting` → `running` explicitly.
- [ ] Apply a global `tools.restrict` allowlist and a path guard:
  - read/glob/grep only under task read roots (cwd + configured directory sources);
  - web_search/web_fetch allowed;
  - `dot_stage_file` only under `.dsh-dot/staging/<taskId>/`; reject traversal/symlinks/oversize;
  - no generic write/edit/bash, no external sends.
- [ ] Add a fake Agent adapter for tests; do not require a live LLM.
- [ ] Add a `WorkerAgentPort` interface and test double for create/followup/status/dispose/result.
- [ ] Tests: spawn, tool denial, staging write, path traversal/symlink rejection, idle result, event emission, duplicate prevention, worker start failure.

### Files

- `src/host/orchestrator/worker-manager.ts` (new)
- `src/host/orchestrator/worker-tools.ts` (new, if separated)
- `src/host/runtime.ts`
- `test/orchestrator.test.mjs`

### Verification

```bash
pnpm typecheck
pnpm build
pnpm test
```

Manual (after Step 6 UI): create a task, assign a worker, observe a real worker Session and a task event.

### Exit criteria

- A worker Agent is real and separately addressable.
- A worker can read a source and write only to staging.
- Worker idle produces a task event and wakes the supervisor (the wake loop may be completed in Step 5).
- No approval authority is exposed to the worker.

### Rollback

Dispose worker handles; revert. Tasks with a `workerId` are marked `blocked/interrupted` by reconciliation.

---

## Step 4 — Task-linked proposals, approvals, and execution

**Goal:** Attach proposals to tasks; route approval/rejection and execution results back into task history; wake the supervisor.

**Depends on:** Steps 2, 3  
**Parallel with:** none  
**Model tier:** default

### Context brief

`src/host/types.ts` has `Proposal`; `runtime.ts` has `approveProposal`, `rejectProposal`, `kickExecution`, `finishExecution`, and `reconcileInterruptedExecution`. The independent reviewer is in `reviewer.ts`.

### Tasks

- [ ] Add `taskId?: string` and `workerId?: string` to `Proposal`.
- [ ] Extend `dot_propose_action` with optional `task_id`.
- [ ] Validate the task exists and is not done/cancelled.
- [ ] Show task context in the review/approval payload and `/dot` command output.
- [ ] On approve/reject:
  - append task event;
  - set task status `waiting_user`/`running` appropriately.
- [ ] On execution result/failure:
  - append `executed`/`failed` event;
  - attach result/artifact;
  - set task `coordinating`;
  - wake supervisor with a bounded event message.
- [ ] Preserve existing `pendingAuto` and execution-start isolation.
- [ ] Tests:
  - proposal with taskId links correctly;
  - approval → executed event;
  - rejection → rejected event;
  - task not found is rejected;
  - execution failure does not mark task done.

### Files

- `src/host/types.ts`
- `src/host/runtime.ts`
- `src/host/tools.ts`
- `src/host/orchestrator/tools.ts`
- `test/orchestrator.test.mjs`

### Verification

```bash
pnpm typecheck
pnpm build
pnpm test
```

Manual: approve a synthetic task-linked proposal; confirm task history and a supervisor wake.

### Exit criteria

- Every task-related proposal is traceable to a task.
- The user remains the only approver.
- Execution results reach task history.
- Existing no-task proposals still work.

### Rollback

Revert the schema/feature flag; unlinked proposals remain valid.

---

## Step 5 — Coordinator: queue, focus, concurrency, and switching

**Goal:** Run up to two tasks concurrently, prioritize the focused task, queue the rest, and switch focus without cancelling work.

**Depends on:** Steps 3, 4  
**Parallel with:** none  
**Model tier:** strongest

### Context brief

The worker manager can spawn workers; tasks have status/priority. The coordinator is the only place that decides which task gets a worker slot. Focus is a user preference, not a cancellation.

### Tasks

- [ ] Add `src/host/orchestrator/coordinator.ts`; it depends on the `WorkerAgentPort` interface, not directly on `ctx.agents`.
- [ ] Add a `coordinatorIntervalMs` maintenance tick (pump/timeouts/reconcile); do not invoke `runResearch` in orchestrator mode.
- [ ] Implement `pump()`:
  - serialized by a mutex;
  - select focused + priority + oldest planned;
  - respect `maxWorkers`;
  - never double-spawn a task;
  - skip `coordinating`/`waiting_user`/`blocked`/`done`.
- [ ] Implement focus update (`setFocus`) and priority ordering.
- [ ] Implement supervisor event queue:
  - if supervisor busy, queue;
  - flush after idle;
  - dedupe event ids.
- [ ] Implement task switch behavior:
  - focusing does not pause/cancel others;
  - waiting tasks remain parked;
  - blocked tasks do not consume slots.
- [ ] Implement basic cancel/retry hooks (full recovery in Step 8).
- [ ] Tests:
  - three tasks with cap 2 → two run, one queues;
  - focus jumps the queue;
  - switching focus does not cancel;
  - same task cannot get two workers;
  - supervisor busy queues events and flushes once.

### Files

- `src/host/orchestrator/coordinator.ts` (new)
- `src/host/runtime.ts`
- `test/coordinator.test.mjs` (new)
- `test/orchestrator.test.mjs`

### Verification

```bash
pnpm typecheck
pnpm build
pnpm test
```

Manual: use a fake adapter; create three tasks; observe two running and one planned; change focus; observe ordering.

### Exit criteria

- Concurrency cap is enforced.
- Focus affects priority only.
- No duplicate worker.
- Events do not interleave into a running supervisor turn.

### Rollback

Disable `orchestrator`; workers are cancelled/reconciled; no task data lost.

---

## Step 6 — Right rail/panel task workspace

**Goal:** Make the native Dot workspace show real tasks, focus, workers, approvals, artifacts, and activity.

**Depends on:** Step 5  
**Parallel with:** none  
**Model tier:** default

### Context brief

`src/client.ts` already registers:
- right sidebar tab `dsh-dot` (body keyed by `TAB_ID`);
- header action `dsh-dot-rail`;
- sidebar footer action `dsh-dot-session`;
- main panel `dsh-dot-plugin`.

The current rail shows proposals/tasks/triggers but no focus, worker detail, artifacts, or activity.

### Tasks

- [ ] Extend `DotState`/`ClientState` client types.
- [ ] Add `POST /dsh-dot/focus` Host route (or implement in Step 5 if preferred; wire here).
- [ ] Change the panel/rail **Run research now** action to **Check tasks** (coordinator tick) in orchestrator mode; keep the legacy label only when disabled.
- [ ] Rail:
  - Dot status + focused task;
  - task list with status dots and worker indicator;
  - click task → focus;
  - focused task detail: plan/next/blocked reason/worker;
  - approvals linked to task;
  - workers section (real status, session link if available);
  - outputs/artifacts;
  - recent activity (bounded events).
- [ ] Full panel: same data in a larger layout; task board by status.
- [ ] Add explicit empty/loading/error states.
- [ ] Add `data-dsh-dot-*` hooks for tests/inspection.
- [ ] Do not show a fake computer/Slack/voice.
- [ ] Build and syntax-check Client bundle.

### Files

- `src/client.ts`
- `src/host/http.ts`
- `src/host/runtime.ts`
- `locale/en.json`, `locale/zh.json`
- `test` (no browser test required; add type/build checks)

### Verification

```bash
pnpm typecheck
pnpm build
node --check lib/client.js
pnpm test
```

Manual after Desktop restart:

- Dot Session header **Dot** opens the rail.
- Task cards show real status.
- Clicking a task changes focus.
- Approvals work from the rail.
- Outputs open real files/links.

### Exit criteria

- UI reflects real task/worker state.
- Focus is visible and switchable.
- No unsupported surface is faked.
- Build/CI green.

### Rollback

Revert Client-only changes; the Host API remains compatible. The old rail/panel returns.

---

## Step 7 — Human-like communication and single-task E2E

**Goal:** Make Dot's updates concise, evidence-based, and decision-oriented; prove one task end-to-end with a real worker.

**Depends on:** Steps 4, 5, 6  
**Parallel with:** none  
**Model tier:** strongest

### Context brief

The supervisor is the user-facing voice. Worker events must be transformed into milestones, not pasted transcripts. The reference behavior is the user asking a follow-up and Dot answering from live state.

### Tasks

- [ ] Add a communication section to the supervisor prompt:
  - first person;
  - task name/status;
  - what happened / evidence;
  - what is not done;
  - one decision request;
  - no raw logs.
- [ ] Add a worker-event-to-supervisor message formatter with bounded fields.
- [ ] Add a `dot_notify_user` helper? Prefer assistant text; do not add a redundant tool unless needed.
- [ ] Add a “task update” discipline: every worker event must produce a task event and either a user update or a deliberate no-update reason.
- [ ] Add a fake-LLM E2E test for the supervisor loop:
  - user request → create task → assign worker;
  - worker result → supervisor update;
  - proposal → approve → execution → done.
- [ ] Run a manual real E2E with one task and one source.
- [ ] Compare messages against the screenshot's communication principles.

### Files

- `src/host/orchestrator/supervisor.ts`
- `src/host/orchestrator/coordinator.ts`
- `test/e2e-orchestrator.test.mjs` (new)
- `README.md` (usage)

### Verification

```bash
pnpm typecheck
pnpm build
pnpm test
```

Manual: one real task; check updates are not log dumps; check the user can ask “what happened?” and get a state-based answer.

### Exit criteria

- A real task completes with at least one artifact.
- The user receives at most a few high-signal updates.
- Dot asks exactly one decision at the approval gate.
- Dot states what was not done.

### Rollback

Prompt-only changes can be reverted; task/worker behavior remains.

---

## Step 8 — Recovery, cancellation, timeout, and failure isolation

**Goal:** Make orchestration safe across failures, restarts, and user cancellation.

**Depends on:** Step 7  
**Parallel with:** none  
**Model tier:** default

### Context brief

Current `reconcileInterruptedExecution()` handles an interrupted execution. The new layer needs equivalent reconciliation for worker Agents and tasks.

### Tasks

- [ ] On startup:
  - load state;
  - find `workers` with `starting`/`running`;
  - check `ctx.agents.get(sessionId)`;
  - if no live agent → task `blocked` with `blockedReason: 'interrupted'`;
  - do not auto-spawn a replacement until the supervisor decides.
- [ ] Worker timeout:
  - per-turn timer;
  - mark failed/timeout;
  - task event;
  - supervisor wake.
- [ ] Worker max turns:
  - limit follow-ups;
  - mark blocked with `needs_user`;
- [ ] Cancel:
  - supervisor tool and/or UI action;
  - dispose worker;
  - task `cancelled` or back to `planned` (explicit choice).
- [ ] Retry:
  - only via a new worker or resumed worker;
  - preserve old events;
  - no duplicate worker.
- [ ] Failure isolation:
  - one task failure does not stop others;
  - supervisor reports and continues.
- [ ] Tests:
  - restart with a running worker → blocked/interrupted;
  - timeout → failed/blocked;
  - cancel → worker disposed, state terminal;
  - retry → single new worker;
  - one failure does not block the other task.

### Files

- `src/host/orchestrator/worker-manager.ts`
- `src/host/orchestrator/coordinator.ts`
- `src/host/runtime.ts`
- `test/coordinator.test.mjs`
- `test/task-state.test.mjs`

### Verification

```bash
pnpm typecheck
pnpm build
pnpm test
```

Manual: kill/restart Host while a worker runs; confirm no false `running`.

### Exit criteria

- No task is silently `running` without a live worker.
- A failed task has a reason and next action.
- Other tasks continue.
- Retry does not duplicate workers.

### Rollback

Disable orchestrator; reconcile all workers to blocked; no data loss.

---

## Step 9 — Schedules/triggers → tasks; docs and migration notes

**Goal:** Make scheduled checks and events create tasks instead of one-off research prompts; document the new model.

**Depends on:** Steps 2, 5, 8  
**Parallel with:** none  
**Model tier:** default

### Context brief

Existing `dot_schedule_task` uses `ctx.schedule`; `dot_register_trigger` fires `fireTrigger`. In the orchestrator, a scheduled check/event should create a task (or update an existing one) and let the supervisor decide whether to assign a worker.

### Tasks

- [ ] Schedule delivery:
  - create a task with a stable title/source;
  - avoid duplicate tasks for the same scheduled occurrence;
  - wake supervisor.
- [ ] Trigger delivery:
  - create/attach a task;
  - include payload evidence;
  - no direct execution.
- [ ] User-visible task origin (`schedule`/`trigger`).
- [ ] Add tests for duplicate schedule/trigger tasks.
- [ ] Update README:
  - supervisor/worker architecture;
  - task lifecycle;
  - focus/switch;
  - approvals;
  - MCP;
  - limitations;
  - migration/backup;
  - feature flag.
- [ ] Add `specs/001-dot-orchestrator/` links to README.
- [ ] Update `dsh.plugin.json`/package version to `0.3.0` only at the end of this step or Step 10.

### Files

- `src/host/orchestrator/coordinator.ts`
- `src/host/runtime.ts`
- `src/host/tools.ts`
- `README.md`
- `test/coordinator.test.mjs`

### Verification

```bash
pnpm typecheck
pnpm build
pnpm test
```

Manual: trigger an event; confirm a task appears; no direct execution.

### Exit criteria

- Schedules/triggers create tasks.
- Duplicate delivery does not duplicate tasks.
- README matches the implemented behavior.
- Existing schedules/triggers still work.

### Rollback

Disable orchestrator event-to-task bridge; existing prompt path remains.

---

## Step 10 — Two-task acceptance and v0.3.0 release

**Goal:** Prove the product behavior the user asked for: two tasks, real workers, focus switching, user communication, approvals, artifacts, and recovery.

**Depends on:** all previous  
**Parallel with:** none  
**Model tier:** strongest

### Context brief

This is the acceptance gate, not just a test run. Do not release if any AT scenario fails.

### Tasks

- [ ] Run AT-1 through AT-7 from `spec.md` against a real DSH instance.
- [ ] Two tasks:
  - one read-only research/draft task;
  - one file-producing task requiring approval;
  - start both; switch focus; ask status; finish both.
- [ ] Verify:
  - task/worker states are real;
  - no duplicate worker;
  - no unapproved write;
  - outputs attached;
  - supervisor updates are concise and evidence-based;
  - restart recovery works;
  - one failure does not stop the other.
- [ ] Run:
  - `pnpm typecheck`
  - `pnpm build`
  - `pnpm test`
  - `node --check lib/client.js`
  - GitHub CI on the release commit.
- [ ] Update package/dsh.plugin/README version to `0.3.0`.
- [ ] Create a release note with migration/feature-flag/known-limitations.
- [ ] Tag `v0.3.0`.
- [ ] Ask the user to accept the acceptance run before publishing the release.

### Exit criteria

- AT-1..AT-7 pass with evidence.
- The user can see and switch tasks in the rail.
- A real task produces a real artifact after approval.
- No safety boundary is bypassed.
- CI green.
- User accepts.

### Rollback

Do not tag/release. Set `orchestrator: false`; restore v1 state backup if migration is the issue; keep the branch for fixes.

---

## Dependency graph

```text
Step 1
 ├─▶ Step 2 ─┐
 └─▶ Step 3 ─┴─▶ Step 4 ─▶ Step 5 ─▶ Step 6 ─▶ Step 7 ─▶ Step 8 ─▶ Step 9 ─▶ Step 10
```

Critical path: **1 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10**.

Step 2 and Step 3 can run in parallel after Step 1. Steps 6–10 are serial to avoid overlapping Coordinator/Client changes.

---

## Plan changes

| Date | Change | Reason |
| --- | --- | --- |
| 2026-10-20 | Initial plan | SDD planning round |

---

## Global acceptance checklist

- [ ] Spec AT-1..AT-7 pass.
- [ ] Two tasks run; focus switches; neither is cancelled.
- [ ] Worker tools are scoped; staging-only writes.
- [ ] User-only approval is intact.
- [ ] Task state survives restart; no false running.
- [ ] Right rail/panel shows real data.
- [ ] Communication is concise and evidence-based.
- [ ] Schedules/triggers create tasks.
- [ ] Docs, version, CI, release notes complete.
- [ ] User explicitly accepts the result.

---

## Explicitly not in this plan

- Cloud computer provisioning.
- Slack/voice calls.
- App marketplace.
- Task DAGs/sub-tasks.
- Multi-user shared queues.
- Unsupervised high-risk external actions.
