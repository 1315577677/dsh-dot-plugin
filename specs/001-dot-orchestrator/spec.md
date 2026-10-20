# 001 — DSH Dot Task Orchestrator

**Status:** Draft for review  
**Date:** 2026-10-20  
**Project:** `dsh-dot-plugin`  
**Scope:** v0.3.0 orchestrator MVP

---

## 1. Problem

The current DSH Dot is a persistent research + approval agent. It can inspect read-only sources, create a proposal, wait for a user decision, and run one scoped execution turn.

That is not the product we are trying to build. The intended Dot is a **task coordination layer** between the user and one or more workers:

- it understands a user request;
- turns it into a named, durable task;
- assigns real work to a worker;
- tracks progress and blocked states;
- communicates progress in a human, concise way;
- asks the user only for decisions and missing information;
- keeps several tasks moving and lets the user switch focus;
- attaches real outputs to tasks;
- preserves the safety rule that only the user can approve consequential actions.

The reference behavior is the OpenAI Dot shown in the supplied screenshot: a persistent “dot” conversation with recent activities, outputs, a worker/computer surface, and task-focused follow-ups such as “is this someone else’s issue?”.

---

## 2. Goals

1. Make Dot a **supervisor**, not the worker that does every step itself.
2. Give every request a durable **Task** with owner, status, worker, plan, next action, artifacts, and history.
3. Run workers in separate DSH Agent Sessions with task-scoped tools.
4. Return worker progress to Dot as events; Dot decides whether to continue, ask the user, switch tasks, or finish.
5. Support at least **two concurrent tasks** and a focused task, without losing the others.
6. Make user communication feel like a competent operator: concise, evidence-based, explicit about what is done and not done, and asking one decision at a time.
7. Keep the existing safety model: read-only research, user-only approval, scoped execution, no interception of the user’s normal Sessions.
8. Expose the task workspace in the native DSH Dot right rail and full panel.

---

## 3. Non-goals

- A hosted cloud computer or remote desktop.
- Slack, voice calls, or an app marketplace.
- Exact visual cloning of OpenAI Dot.
- Multi-user teams, shared task queues, or organization permissions.
- Unlimited autonomous workers.
- Bypassing DSH approvals or writing outside configured workspaces.
- A general-purpose workflow engine or DAG editor.

Real app connectors remain MCP-backed and read-only by default. The computer/Slack surface in the reference screenshot is replaced by **Workers** and **Connectors** in the DSH-native UI.

---

## 4. Users and jobs

### User story A — delegate one task

> I ask Dot to investigate a bug and prepare a fix. Dot creates a task, starts a worker, tells me what it found, asks me before writing/pushing, and attaches the result.

### User story B — manage several tasks

> I have three tasks in progress. Dot shows each status, lets me focus one, keeps the others moving, and answers “what’s happening with task 2?” without losing context.

### User story C — decision gate

> A worker needs permission to modify a real file or send an external message. Dot explains the exact action, asks once, and does nothing until I approve.

### User story D — blocked/failed work

> A worker is blocked. Dot reports the blocker, proposes the next step, and moves to another task if I want.

### User story E — recovery

> DSH restarts. Dot restores tasks and status. A worker that was interrupted is marked interrupted and can be resumed or retried without duplicating work.

---

## 5. Functional requirements

### Task model

- **FR-001** A task MUST have: id, title, user request, status, priority, created/updated timestamps, current worker reference, plan, next action, artifacts, and an event history.
- **FR-002** Task status MUST be one of: `inbox`, `planned`, `running`, `coordinating`, `waiting_user`, `blocked`, `done`, `failed`, `cancelled`. `coordinating` means a worker has returned and Dot is reviewing/deciding; no worker is running.
- **FR-003** Only the Dot supervisor service may mutate task state; workers report, they do not own state.
- **FR-004** One task MUST have at most one active worker. The same worker may continue a task across turns.
- **FR-005** A task MUST retain all state needed to answer “what is happening?” without reading raw worker logs.

### Worker orchestration

- **FR-006** Dot MUST be able to create a worker Agent in its own DSH Session with a scoped preset and task brief.
- **FR-007** A worker MUST receive only its task brief, relevant source context, and task-scoped tools. Worker read/glob/grep access SHOULD be limited to the task workspace and configured source roots.
- **FR-008** A worker MUST NOT be able to approve its own actions, approve proposals, or mutate task ownership.
- **FR-009** A worker SHOULD write only to a task staging directory. Promotion to a real workspace path MUST require a user-approved proposal unless the target is explicitly configured as safe.
- **FR-010** Worker completion, failure, timeout, and cancellation MUST produce a task event and wake the supervisor.
- **FR-011** The coordinator MUST enforce a configurable concurrency cap (default 2) and queue the rest.
- **FR-012** A worker turn MUST have a timeout and a maximum number of follow-up rounds to prevent runaway loops.

### Supervision and communication

- **FR-013** Dot MUST create a task for a new user request before delegating substantial work.
- **FR-014** Dot MUST send a user-facing update at meaningful milestones: task accepted, work started, evidence found, blocker, decision needed, completed/failed.
- **FR-015** Dot MUST NOT dump raw tool logs or worker transcripts into the user conversation.
- **FR-016** A decision request MUST state the exact action, why it is needed, what happens on approval, and what has not been done yet.
- **FR-017** Dot SHOULD keep task updates in the first person and make the task context explicit.
- **FR-018** A user SHOULD be able to ask about any task and switch the focused task without stopping the others.

### Approvals and execution

- **FR-019** A proposal MUST be associated with a task when it was produced for that task.
- **FR-020** Approval and rejection MUST remain user-only, through the native panel, the right rail, or the `/dot` command.
- **FR-021** An approved execution MUST receive only the proposal’s execution tools plus safe read support.
- **FR-022** An execution result or failure MUST be appended to the task history and wake the supervisor.
- **FR-023** External sends, publishes, deletes, payments, and credential access MUST NOT be available to workers and MUST remain explicit user-approved proposals.

### Persistence and recovery

- **FR-024** Task state MUST survive plugin reload and DSH restart.
- **FR-025** State MUST be migrated from the v1 proposal/task format without losing pending proposals or tracked tasks.
- **FR-026** On startup, tasks with a live worker that is no longer running MUST be marked `interrupted` or `blocked`; they MUST NOT silently appear `running`.
- **FR-027** The coordinator MUST avoid duplicate workers for the same task after a restart or retry.

### UI and observability

- **FR-028** The Dot right rail MUST show: Dot status, focused task, other tasks with status, pending approvals, worker status, artifacts/outputs, and latest activity.
- **FR-029** Clicking a task MUST set it as focused and show its detail; it MUST NOT delete or pause other tasks.
- **FR-030** The full panel MUST expose the same task workspace at a larger size.
- **FR-031** The UI MUST distinguish `running`, `waiting_user`, `blocked`, `done`, and `failed` visibly.
- **FR-032** There MUST be a diagnostic snapshot (state + worker status + last error) accessible through the local bridge.

### Safety and compatibility

- **FR-033** Rules, tool restrictions, and guards MUST remain scoped to Dot/worker Agents and MUST NOT intercept the user’s normal Sessions.
- **FR-034** The existing sources, schedules, triggers, and `/dot` command MUST continue to work.
- **FR-035** The supervisor MUST NOT claim a task is done without an artifact or an explicit verified result.
- **FR-036** The system MUST degrade gracefully if a worker Agent cannot start: the task stays `planned` or `blocked` with an actionable error.
- **FR-037** A worker MUST NOT read arbitrary profile/home paths outside its task read roots; if path-level read scoping is unavailable, the limitation MUST be documented and tested.
- **FR-038** The supervisor MUST be able to continue an existing worker with a new instruction instead of creating a new worker for every step.
- **FR-039** In orchestrator mode, Dot MUST NOT run the legacy periodic research heartbeat; proactive work comes from user requests, worker events, DSH schedules, and event triggers. Legacy research remains available only when `orchestrator: false`.

---

## 6. Acceptance scenarios

### AT-1 — one task end-to-end

1. User asks Dot to inspect a local source and draft a reply.
2. Dot creates task `T1`, assigns a read-only worker, and reports that work started.
3. Worker returns evidence; Dot reports the finding.
4. Dot proposes writing the draft; user approves.
5. Execution writes the file; Dot attaches the artifact and marks `T1` done.
6. The task history shows intake, worker start, evidence, approval, execution, completion.

### AT-2 — two tasks and focus switching

1. User starts `T1` (investigate bug) and `T2` (summarize inbox).
2. Both workers run; Dot reports each independently.
3. User asks “focus T2”; Dot switches focus without cancelling `T1`.
4. User asks “what happened in T1?”; Dot answers from task state/events.
5. Both tasks complete with separate artifacts.

### AT-3 — approval gate

1. Worker prepares a change but does not write the real target.
2. Dot asks for approval with the exact target and consequences.
3. Before approval, the target is unchanged.
4. After approval, the execution turn writes only the approved path.
5. The task links to the result.

### AT-4 — restart recovery

1. Start a worker; restart the Host while it is running.
2. On startup, Dot does not show the task as `running` without a live worker.
3. The task is `interrupted`/`blocked`; Dot offers resume/retry.
4. Retry does not create a second worker for the same task.

### AT-5 — coordinating is not running

1. A worker returns a result.
2. The task becomes `coordinating`, not `running`.
3. Dot reviews the result and either continues, asks the user, or completes.
4. The UI never shows a live worker when none is running.

### AT-6 — failure isolation

1. A worker fails or times out.
2. Dot reports the failure and keeps other tasks running.
3. The failed task has a clear error and a next action.

### AT-7 — no unapproved external action

1. A worker prepares an external send.
2. No send tool is available to the worker.
3. Dot proposes the send; no external effect happens before user approval.

---

## 7. Non-functional requirements

- **NFR-001 Persistence:** state writes are atomic; a crash must not corrupt the state file.
- **NFR-002 Concurrency:** one task cannot have two active workers; coordinator mutations are serialized.
- **NFR-003 Latency:** a task status change should appear in the UI within 2 seconds of the event (poll or push).
- **NFR-004 Safety:** worker and supervisor tool scopes are monotonic within a phase.
- **NFR-005 Recoverability:** all worker sessions and task events are durable or reconstructable.
- **NFR-006 Compatibility:** existing Dot sessions and proposals migrate; existing `/dot` command still works.
- **NFR-007 Testability:** worker orchestration can be tested with a fake Agent/LLM implementation.
- **NFR-008 Observability:** every task transition has an event with actor and timestamp.
- **NFR-009 No global interception:** installing Dot must not replace the user’s normal tool policy.
- **NFR-010 UI truthfulness:** no fake computer/Slack/voice UI; unsupported surfaces are omitted or labeled.

---

## 8. Constraints and constitution

1. **Read-only first.** External evidence is gathered read-only.
2. **User-only approval.** No Agent tool can approve a proposal.
3. **Scoped execution.** Every execution has an allowlist.
4. **Durable state.** Tasks are not ephemeral chat context.
5. **No global hijack.** Dot rules never apply to unrelated Sessions.
6. **No fake capability.** UI must represent real workers/tools.
7. **Small PRs.** Each implementation step is independently verifiable.
8. **Test the state machine.** Concurrency and recovery are first-class tests.

---

## 9. Success metrics

- A user request becomes a task without manual task creation.
- At least two tasks can be active; switching focus does not cancel either.
- Every worker completion produces a Dot user update and a task event.
- Zero unapproved writes/sends in the acceptance run.
- A restart never leaves a task falsely `running`.
- The right rail answers “what is Dot doing?” without opening raw logs.

---

## 10. Open questions resolved for MVP

| Question | Decision |
| --- | --- |
| One chat or per-task chats? | One Dot conversation; task focus and task detail live in the rail. |
| Who executes approved actions? | A dedicated execution turn; the supervisor remains the coordinator. |
| Can workers write? | Only to a task staging directory in MVP; promotion is approved. |
| How many workers? | Default 2 concurrent; configurable. |
| How are tasks prioritized? | Focus + priority + FIFO; focus does not cancel others. |
| How does a user switch? | Natural language to Dot, or clicking a task in the rail. |
| What about Slack/computer? | Out of scope; replaced by Workers/Connectors and MCP. |
| Does Dot do research itself? | Lightweight status/verification only; substantial work goes to a worker. |

---

## 11. Out of scope for v0.3.0

- Task dependencies/DAGs.
- Sub-task trees and nested workers.
- Shared team task queues.
- Voice interface.
- Remote computer provisioning.
- App marketplace.
- Auto-approval of high-risk external actions.

These can be evaluated after the MVP acceptance run.
