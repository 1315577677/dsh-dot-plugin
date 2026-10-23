# DSH Dot

[![CI](https://github.com/1315577677/dsh-dot-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/1315577677/dsh-dot-plugin/actions/workflows/ci.yml)

![DSH Dot](icon.svg)

**A persistent, read-only-first proactive agent for DeepSeek Harness, with user-approved execution.**

`dsh-dot-plugin` is a DSH plugin that gives DeepSeek Harness a real Dot: its own durable Agent Session, a read-only research phase, independent risk review, user-only approvals, and a tightly-scoped execution phase.

It is inspired by the capability model of OpenAI's Dots, but it is an independent open-source project. It is not affiliated with, endorsed by, or connected to OpenAI, and it does not attempt to reproduce OpenAI's hosted cloud computer or 4,000+ app marketplace.

---

## Why

Most agent plugins are reactive: they answer, then stop. Dot is designed to keep a thread of work alive:

1. inspect real, configured sources without modifying anything;
2. decide whether something is worth doing;
3. prepare a concrete proposal;
4. ask the user when the action has real-world consequences;
5. execute only the approved action, with only the approved tools;
6. record the real result and keep long-running work moving.

The ordinary conversation you use to code is **not** intercepted. Dot has its own Session and its own tool policy.

---

## Features

| Capability | How it works |
| --- | --- |
| Persistent Dot Agent | A top-level Agent/Session resumed from durable state; title `Dot` |
| Task orchestrator | Dot creates tasks, assigns real worker Agents, tracks status, handles approvals, and lets the user switch focus |
| Single Dot entry | One sidebar entry opens the Dot conversation; the board/right-rail/footer duplicates are removed |
| Read-only research | Global tool allowlist + a scoped, monotonic `tools.guard()` |
| Real sources | Local directories, public/API URLs, and read-only MCP tools |
| Proposals | `dot_propose_action` writes a durable proposal; it never executes |
| Independent risk review | A separate small model classifies every proposal; the proposing model does not grade itself |
| User-only approval | DSH panel and `/dot` slash command; no Agent Tool can approve a proposal |
| Scoped execution | An approved execution turn receives only that proposal's tools |
| Task tracking | `dot_add_task` / `dot_update_task`; progress comes from real evidence |
| DSH schedules | `dot_schedule_task` uses the Host `schedule` service, not a private cron loop |
| Event triggers | `dot_register_trigger` + local webhook/service entry point |
| No global rule hijack | Rules apply to Dot only, not to the user's other Sessions |
| Result attribution | Execution results are read only from the execution turn, and interrupted turns are marked failed |

---

## Architecture

```text
                       ┌─────────────────────────────┐
                       │        DSH Host             │
                       │                             │
  user approval ──────▶│  DotRuntime                 │
  (panel or /dot)      │   ├─ Dot Agent/Session      │
                       │   ├─ read-only research     │
                       │   ├─ proposal store         │
                       │   └─ execution allowlist    │
                       │                             │
  sources ────────────▶│  read / glob / grep         │
  (directory/URL/MCP)  │  web_search / web_fetch     │
                       └──────────────┬──────────────┘
                                      │ DSH slots
                       ┌──────────────▼──────────────┐
                       │      Client panel           │
                       │  sidebar icon + main panel  │
                       │  proposals / tasks / status │
                       └─────────────────────────────┘
```

The Dot Agent is created with the `standard` DSH preset, then a Dot-scoped prompt section and scoped tools are added.

### Research phase

- Allowed global tools default to `read`, `glob`, `grep`, `web_search`, `web_fetch`.
- Everything else is removed with `tools.restrict()` when possible.
- A scoped `tools.guard()` denies any other call even if a preset-scoped tool is not filtered by the global restriction.
- The research prompt tells Dot to inspect only the configured sources and to propose — not execute — work.
- `dot_schedule_task`, `dot_add_task`, and `dot_register_trigger` are internal bookkeeping tools and remain available during research.

### Proposal phase

`dot_propose_action` records:

- title, description, proposed outcome;
- source and evidence;
- `execution_tools` (for example `["write"]`);
- an exact `execution_instruction`.

A separate `Reviewer` asks a small model for a risk verdict (`low` / `medium` / `high`) with a reason. User rules are applied after that. The default configuration does **not** auto-approve even low-risk proposals; opt in with `autoApproveLowRisk: true`.

### Execution phase

Approval is user-only. On approval:

1. the research restriction is lifted;
2. an execution allowlist is built from the proposal's `executionTools` plus `read` / `glob` / `grep`;
3. the Dot Agent receives an execution prompt in the same Session;
4. the scoped guard denies every tool outside that allowlist;
5. when the turn ends, the result is read from that turn only and written back to the proposal.

High-risk actions such as send, publish, pay, delete, invite, or credential access are expected to be proposed as drafts or preparatory steps. The user can reject them, or configure stricter rules.

---

## Requirements

- DeepSeek Harness **Desktop** or `dsh web` profile
- Node.js >= 22
- pnpm
- A working default model route in DSH
- For real app connectors: the corresponding read-only MCP tools in DSH

The plugin was tested against the DSH `0.2.1-rc.2` family.

---

## Install

```bash
git clone https://github.com/1315577677/dsh-dot-plugin.git
cd dsh-dot-plugin
pnpm install
pnpm build
pnpm test
```

Then install the local bundle with DSH's Plugin Manager:

```text
plugin_manager install_bundle target=/absolute/path/to/dsh-dot-plugin
```

Or install it from the DSH Plugin Manager UI by choosing the local bundle directory.

### Desktop note

The Host half activates immediately. The Client half (sidebar icon + panel) is part of the web boot graph, so **fully quit and reopen DSH Desktop** after installing or replacing the Client bundle. A browser-style page refresh is not available in the Desktop shell.

After reopening, the sidebar shows **DSH Dot** and the Dot Session appears in the Session list.

---

## Configure sources

The default `cordis.patch.yml` intentionally contains no machine-specific sources. Add real read-only sources under the `config.sources` list and reinstall the bundle (or override the row in your profile patch).

### Local directory

```yaml
- insert:
    - id: dsh-dot-plugin
      name: 'dsh-dot-plugin'
      config:
        enabled: true
        agentPreset: standard
        dotWorkspace: '/absolute/path/to/workspace'
        sources:
          - id: inbox
            kind: directory
            label: Local inbox
            path: '/absolute/path/to/inbox'
        readOnlyTools: [read, glob, grep, web_search, web_fetch]
        executionTools: [write, edit]
```

`dotWorkspace` is the Dot Session's cwd and the workspace used by the file sandbox. It should contain the files you want Dot to be able to write after approval.

### Public URL / API

```yaml
sources:
  - id: github
    kind: url
    label: GitHub issues
    url: 'https://api.github.com/repos/owner/repo/issues?state=open&per_page=10'
```

Dot uses `web_fetch` for URL sources.

### Real apps via MCP

Connect Gmail, Google Calendar, Slack, GitHub, or another app through DSH's MCP support, then expose only read tools to Dot:

```yaml
sources:
  - id: mail
    kind: mcp
    label: Gmail read-only
    tools: [gmail_search, gmail_read]

readOnlyTools:
  - read
  - glob
  - grep
  - web_search
  - web_fetch
  - gmail_search
  - gmail_read
```

This plugin does not embed OAuth credentials, app passwords, or a vendor connector. The MCP server owns authentication and the tool surface; DSH owns the tool registry.

### Demo fixtures

The repository includes realistic sample files in `dot-demo/inbox/`. To try the plugin:

1. set `dotWorkspace` to the repository root;
2. set a directory source to `<repo>/dot-demo/inbox`;
3. reinstall and reopen Desktop;
4. open the DSH Dot panel and click **Run research now**.

The included `dot-demo/outbox/` starts empty; files appear only after an approved execution.

---

## Configuration reference

| Key | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Enable the Dot runtime |
| `initialDelayMs` | `20000` | Delay before the first research round |
| `researchIntervalMs` | `300000` | Research heartbeat |
| `agentPreset` | `standard` | Preset mounted into the Dot/worker Agents; supplies read/web tools |
| `orchestrator` | `true` | Enable the task supervisor/worker model; set false for legacy research |
| `maxWorkers` | `2` | Maximum concurrent worker Agents |
| `workerMaxTurns` | `3` | Follow-up turns per worker |
| `workerTimeoutMs` | `900000` | Worker turn timeout |
| `workerStageMaxBytes` | `1048576` | Max size of one staged file |
| `dotWorkspace` | profile default | Dot Session cwd / write sandbox root |
| `sources` | `[]` | Directory, URL, or MCP sources |
| `readOnlyTools` | `[read, glob, grep, web_search, web_fetch]` | Global tools available during research |
| `executionTools` | `[write, edit]` | Tools a proposal may request for execution |
| `reviewProvider` | current default | Small-model provider for risk review |
| `reviewModel` | current default | Small-model model for risk review |
| `reviewTimeoutMs` | `20000` | Risk review timeout |
| `rules` | built-in defaults | `{ action_pattern, decision: allow \| ask \| deny }` |
| `autoApproveLowRisk` | `false` | Auto-run proposals that are both rule-allowed and low risk |
| `maxProposalsPerRound` | `3` | Proposal cap per research turn |
| `stateDir` | `<plugin>/data` | Durable plugin state directory |

Rules are regular expressions tested against the proposal's action type, title, outcome, execution instruction, and tools.

---

## Using Dot

### Task orchestrator (v0.3)

Set `orchestrator: true` to turn Dot into a task coordinator:

```yaml
config:
  orchestrator: true
  maxWorkers: 2
  workerMaxTurns: 3
  dotWorkspace: '/absolute/path/to/workspace'
```

In this mode:

- Dot is a **supervisor**, not the worker that does every step. In supervisor mode it has no `read`, `glob`, `grep`, `web_search`, `web_fetch`, or generic shell tools; all source evidence comes from workers.
- A user request becomes a durable **task**.
- `dot_assign_worker` starts a separate DSH worker Session, or queues the task when `maxWorkers` is full.
- Workers can read within task roots, search/fetch the web, report progress, and write only to `.dsh-dot/staging/<taskId>/`.
- A worker return moves the task to `coordinating`; worker failure moves it to `blocked`.
- Approved execution runs in a separate **executor Agent Session**, not in the Dot supervisor Session. The Dot conversation shows task events; the executor owns the real write tool turn.
- The supervisor receives a bounded worker event and decides: continue, ask the user, switch focus, or complete.
- `dot_focus_task` / clicking a task in the right rail changes priority, never cancels other tasks.
- Task-linked proposals use `task_id`; approvals and execution results become task events.
- Assignment accepts a `running` task with no active worker, so the supervisor does not need to cancel and recreate a task after a status transition.
- The coordinator pumps the next queued task when a worker slot frees.
- On Host restart, workers that no longer have a live Agent are marked `blocked/interrupted`, never falsely `running`.

Workers do not receive generic `write`, `edit`, or `bash`; they do not receive approval or task-management tools. Real workspace writes still require a user-approved proposal.

**Legacy mode:** with `orchestrator: false`, the v0.2 read-only research + proposal + approved-execution behavior remains available.

### The Dot conversation

There is one user-facing entry: **DSH Dot** in the sidebar.

Clicking it opens the Dot conversation. The conversation is the only user-facing Dot surface:

- the user talks to Dot as a manager;
- Dot delegates work to workers/executors;
- task/worker/tool details stay out of the conversation;
- a small breathing presence appears in the conversation header while Dot is working;
- the DSH chat’s turn-process disclosure is hidden in the Dot Session.

The former control board, the right-rail Dot tab, the header Dot button, and the duplicate footer entry have been removed.


### `/dot` command

For environments where the panel is not loaded yet, the same approval path is available as a user command:

```text
/dot
/dot status
/dot approve <n|proposal-id>
/dot reject <n|proposal-id>
/dot run
```

A slash command is submitted by a human; no Agent Tool can invoke it.

### Event triggers

Register a trigger with the Dot tool or directly through the service:

```js
const dot = ctx.get('dshDot')
await dot.fireTrigger(triggerId, {
  from: 'alerts@example.com',
  subject: 'urgent: production review',
})
```

Local HTTP entry point:

```bash
curl -X POST http://127.0.0.1:<dsh-port>/dsh-dot/trigger \
  -H 'content-type: application/json' \
  -H 'x-dsh-dot: 1' \
  -d '{"triggerId":"trigger_...","payload":{"subject":"urgent"}}'
```

A trigger only wakes Dot for read-only investigation. It does not execute the instruction directly.

---

## Security model

This is a local tool with meaningful authority, so the boundaries are explicit:

- **Read-only by default.** Research has a global allowlist and a scoped monotonic guard.
- **The proposing model is not the safety reviewer.** A separate small model classifies risk using `ctx.llm.stream()`.
- **The user is the only approver.** Proposals are approved through the Client panel or a human slash command; no approval Tool is registered.
- **Execution is scoped.** An execution turn gets only the approved tools plus safe read support.
- **The user's normal Sessions are untouched.** Dot rules and restrictions live in the Dot Agent scope.
- **State is durable.** Plugin state is written atomically to `data/state.json`; the Agent Session log remains the source of truth for conversation and tool outcomes.
- **Local bridge only.** The panel uses same-origin HTTP with an `x-dsh-dot` header and Origin check. It is not an authenticated public API; do not expose it to the public internet.

### Limits

- No cloud computer, browser control, or 4,000-app marketplace.
- No bundled OAuth/Composio integration; use DSH MCP servers for real apps.
- Default auto-approval is off. High-risk work should be proposed as a draft and reviewed.
- A malicious or over-broad MCP tool is outside this plugin's trust boundary. Only expose read tools during research.
- The panel is a supplementary control surface, not a replacement for the Dot conversation.

---

## Orchestrator data and recovery

Task state lives in `data/state.json` (version 2). v1 state is migrated once with `data/state.v1.backup.json`. The state contains:

- tasks with status, priority, plan, next action, events, artifacts, worker reference;
- worker records with Session id, status, last result/error, turns;
- focused task;
- task-linked proposals;
- schedules and triggers.

On startup:

1. v1 state is backed up and migrated;
2. workers recorded as `starting/running` with no live Agent become `failed`;
3. their tasks become `blocked` with `worker_interrupted`;
4. no replacement worker is auto-started;
5. the supervisor can adopt/retry explicitly.

## Limitations of v0.3

- No cloud computer, Slack, voice, or app marketplace.
- Real app connectors still require DSH MCP read-only tools.
- Approved execution is a separate scoped turn; it is not a general worker permission.
- Worker count defaults to 2; focus changes priority, not ownership.
- The supervisor does not claim a task done without an artifact or verified result.

## Project layout

```text
dsh-dot-plugin/
├── package.json
├── cordis.patch.yml           # Loader row: dsh-dot-plugin
├── dsh.plugin.json            # Desktop metadata
├── icon.svg
├── locale/{en,zh}.json
├── src/
│   ├── client.ts              # main panel + sidebar icon
│   └── host/
│       ├── index.ts           # name / inject / Config / apply
│       ├── runtime.ts         # Agent lifecycle, research, execution
│       ├── reviewer.ts        # independent risk model
│       ├── tools.ts           # Dot-scoped tools
│       ├── commands.ts        # /dot user command
│       ├── http.ts            # local panel bridge
│       ├── state.ts           # atomic durable state
│       └── types.ts
├── test/
├── dot-demo/inbox/            # sample real sources
├── data/                      # runtime state (gitignored)
└── lib/                       # built ESM + browser artifact
```

Loader IDs are consistent:

- package / Loader row / Host export: `dsh-dot-plugin`
- Client `__ModuleLoader__.load` id: `dsh-dot-plugin`
- panel slot id and main key: `dsh-dot-plugin`

---

## Development

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test
```

The plugin uses TypeScript compiled to ESM for the Host and a plain module-loader browser artifact for the Client.

### Contributing

Issues and pull requests are welcome. Please keep the read-only research boundary and the user-only approval model intact. For a behavior change that broadens execution authority, include a threat-model note and a test.

---

## License

MIT. See [LICENSE](LICENSE).

---

## 中文简介

DSH Dot（`dsh-dot-plugin`）是一个给 DeepSeek Harness 用的常驻主动 Agent 插件：

- 有自己的 Dot 会话；
- 只读研究真实数据源；
- 生成行动提案，由独立小模型评估风险；
- 只有用户可以在面板或 `/dot` 命令中批准；
- 批准后才进入受限执行，只拿到该提案允许的工具；
- 支持长期任务、DSH 定时任务和本地事件触发；
- 不拦截你日常写代码的主会话。

它不是 OpenAI Dots 的官方实现，也不包含云端电脑、浏览器控制或内置 Gmail/Calendar OAuth；真实应用连接通过 DSH MCP 配置。

---

**Status:** `0.4.0` single-entry Dot chat release. Tested on the DSH `0.2.1-rc.2` family. `orchestrator` defaults to `true`; set it to `false` to use the legacy research mode.
