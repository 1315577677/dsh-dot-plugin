# DSH Dot

[![CI](https://github.com/1315577677/dsh-dot-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/1315577677/dsh-dot-plugin/actions/workflows/ci.yml)

[English](README.en.md) | **简体中文**

> 你的 DeepSeek Harness 个人助手。你把目标交给 Dot，Dot 组织团队执行，最后带着结果回来。

## 快速开始

在 DeepSeek Harness Desktop 里打开 **插件 → 安装**，粘贴下面这一行，然后重启一次：

```
https://github.com/1315577677/dsh-dot-plugin/releases/download/v1.0.0/dsh-dot-plugin-1.0.0.tgz
```

然后打开侧边栏的 **DSH Dot**，直接说你要什么。[更多安装方式](#安装) · [它能做什么](#dot-能替你做什么) · [它怎么工作](#dot-是怎么工作的)

## 使用前后

| 以前 | 用 Dot 之后 |
|---|---|
| 五个会话同时跑，没一个跑完，只有你一直在盯。 | 一个对话。计划、worker、检查、汇报都由 Dot 负责。 |
| worker 卡住了，也没人告诉你。 | Dot 盯着每个 worker，只问你那个能解开卡点的问题。 |
| 结果靠你在窗口之间手动复制。 | 验证过的结果和产物直接落在 Dot 对话里。 |

![DSH Dot 演示](docs/screenshots/dot-demo.gif)
---

## DSH Dot 是什么？

DeepSeek Harness 提供工作区、会话，以及你想开多少就开多少的并行对话。但要一直盯住每个窗口在做什么，本身就成了全职工作。

DSH Dot 是这之上的一层。它不是又一个编程会话，而是你唯一需要对话的地方，由它掌管工作：

- 你说你想要什么；
- Dot 立刻回应，把请求拆成任务，派出去；
- 后台 worker 在真实的 DeepSeek Harness 会话里做调研、改代码、跑命令；
- Dot 检查返回的结果，不对就打回去，确认没问题后再告诉你。

你不需要切换窗口去管进度。想看可以看——每个 worker 都是真实会话——但你不必看。

## Dot 能替你做什么

| | |
|---|---|
| **一个入口** | 侧边栏里专属的 Dot 对话。没有工作区选择，没有模式选择，也没有工具噪音。你说，Dot 管。 |
| **真实任务** | 每个请求都会变成一条持久任务，带状态、计划、证据和负责人。任务能跨重启存活。 |
| **可见的委派** | 每条任务都在各自命名的 Harness 会话里运行（`Dot · <task>`）。Dot 交给 worker 的 brief 是一条真实的用户消息，可以打开阅读。 |
| **工作区隔离** | 任务可以指向你的任一 Harness 工作区。worker 只在**那个工作区里**拥有 `read`、`glob`、`grep`、`write`、`edit`、`bash` 和联网工具。 |
| **追加还是依赖** | 补充或修正直接追加进正在跑的任务（`dot_append_task`），不用等。真正需要前一个结果的新步骤用 `depends_on` 建新任务，依赖完成才开始。 |
| **真正能取消** | 停掉任务会中止 worker 当前的 turn 并释放它的 agent，token 会真正停止消耗。 |
| **长期记忆** | `dot_remember` / `dot_recall` 跨会话保存有来源的事实（偏好、决定、项目背景），附带文件/日期/片段证据。不编造，拒绝密钥。 |
| **Worker 容量** | 2–8 个 worker 槽位，持久化保存。排队时会说明卡在哪件事后面；调高上限前会先问你。 |
| **像人一样的聊天** | 短句、纯文本，一条消息只表达一个意思，气泡逐条出现，引用回复可以跳到原消息。 |
| **由管理者复核的审批** | worker 的审批请求交给 Dot：明显安全的操作放行一次，明显不安全直接拒绝，拿不准的变成 Dot 对话里的卡片。Dot 自己的提案仍然需要你批准。 |
| **对话式定时任务** | 说“每天九点”或“每小时检查一次”，Dot 会创建自己的持久定时任务，可以列出、修改、取消，每次触发都变成一条任务或一次汇报。 |
| **可选的主动性扫描** | 一个独立的只读扫描器，先对最近的工作区活动排序，再只深入扫描你实际在用的工作区。高置信度的发现交给 Dot，绝不自动修改。默认关闭。 |

## Dot 是怎么工作的

Dot 是一个带循环的管理者，不是“恰好被聊天调用的模型”。

```
   你
    │  需求
    ▼
 ┌──────────────┐          ┌──────────────────────────────────────────┐
 │  Dot 对话    │─────────▶│              DOT（管理者）               │
 │ （唯一界面） │          │  1 接单    一两句先确认                  │
 └──────────────┘◀─────────│  2 拆解    任务 + 下一步                 │
    ▲  结果                │  3 派活    分配给 worker                 │
    │                      │  4 验收    看证据，不行就打回            │
    │                      │  5 汇报    结果，或只问一个问题          │
    │                      │  6 归档    有证据才关闭任务              │
    │                      └───────┬──────────────────────┬───────────┘
    │                              │ 派发                 │ 批准
    │                              ▼                      ▼
    │                    ┌──────────────────┐   ┌────────────────────┐
    │                    │  Worker Agent    │   │  Executor Agent    │
    │                    │  独立会话        │   │  独立会话          │
    │                    │  目标任务工作区  │   │  已批准的工具      │
    │                    │  读写/编辑/bash  │   │  只做批准的动作    │
    │                    └─────────┬────────┘   └─────────┬──────────┘
    │                              │ 结果 / 进度          │ 结果
    │                              ▼                      ▼
    │                    ┌──────────────────────────────────────┐
    └────────────────────│  事件 → 任务状态 → Dot 复查          │
                         └──────────────────────────────────────┘
```

具体循环：

1. **接单。** 你发一条消息，Dot 先回答——它理解了什么、准备做什么——然后才开始干活。
2. **拆解。** 请求变成一条任务，带标题、原始请求、计划和下一步。
3. **派活。** `dot_assign_worker` 把任务交给调度器。有空位就立刻开工，否则排队，Dot 会告诉你排在哪件事后面。
4. **执行。** worker 在自己的 Harness 会话里跑，作用域是任务工作区。可以在那里改文件、跑命令，过程中汇报进度，最后给出结果。
5. **验收。** worker 回来后唤醒 Dot。Dot 读取结果，对照请求检查，要么接受，要么继续给同一个 worker 下指令，要么只问你一个问题。
6. **汇报。** 核实过的结果以普通消息出现在 Dot 对话里。只有拿到产物或已核实的结论，任务才关闭。

循环之外还有几条原则：

- **打断是常态。** 活还在跑时会有新消息进来。Dot 会逐条判断：追加到正在跑的任务、创建有依赖的新任务，还是创建无关的新任务。不会静默丢弃，也不会让本该立刻执行的事去排队。
- **一切可查。** 任务事件、产物、worker 会话、记忆文件都在磁盘上。Dot 跑过什么从来不是黑盒。
- **有后果的事不独自决定。** 批准权只属于用户。worker 不能批准自己的工作，执行器只做被批准的事。
- **Dot 从不亲自干活。** 管理者模式下 Dot 没有 `read`、`write`、`bash` 或联网工具。派不出去就报告卡点，而不是悄悄自己变成 worker。

## v1.0.0

0.x 迭代后的第一个稳定版本。新增了 Dot 自己的定时任务、可选的工作区主动性扫描、插件设置页，以及最终的聊天回执与引用行为。

## 安装

### 方式 A —— 从插件目录安装（最简单）

DeepSeek Harness Desktop 通过 *spec* 安装插件。插件发布到 registry 后可以用包名，也可以用 tarball 链接或本地目录：

```
dsh-dot-plugin
```

```
https://github.com/1315577677/dsh-dot-plugin/releases/download/v1.0.0/dsh-dot-plugin-1.0.0.tgz
```

步骤：

1. 打开 **DeepSeek Harness Desktop**。
2. 点左侧边栏的 **插件 / Plugins**。
3. 把上面的 spec 粘贴到安装框并确认。
4. 等它显示已安装，然后完整重启一次应用。

重启后，**DSH Dot** 会出现在侧边栏的 **自动化任务** 下面。点开就是 Dot 对话。

> 没有发布 tarball 的构建，也可以用绝对路径安装（`/absolute/path/to/package` 或 `link:/absolute/path/to/package`）。

### 方式 B —— 从源码安装（贡献者）

```bash
git clone https://github.com/1315577677/dsh-dot-plugin.git
cd dsh-dot-plugin
pnpm install
pnpm build        # 编译 host 和 client
pnpm test         # node --test
```

然后按方式 A，用克隆目录的绝对路径安装。

### 方式 C —— tarball 发布包

每个 GitHub Release 都会附带 `dsh-dot-plugin-<version>.tgz`，也就是 `npm pack` 产出的同一个文件。里面包含编译好的 `lib/`、`cordis.patch.yml`、客户端 bundle 和语言包，所以不装工具链也能安装。

### 环境要求

- DeepSeek Harness Desktop `0.2.1-rc.2` 或更新
- 只有从源码构建才需要 Node.js 22+
- 一个给 Dot 干活的工作区；默认为当前工作区

### 第一次使用

1. 点侧边栏的 **DSH Dot**。
2. 说一件具体的事：*“检查这个工作区里失败的测试并修好。”*
3. Dot 先回一两句，创建一条任务，派一个 worker。
4. 工作区列表里会出现 `Dot · <task>` 会话。想看可以打开。
5. 结果核实后，Dot 会在对话里汇报。

## 配置

bundle patch 会插入一行插件。`cordis.patch.yml`（或你的 profile 覆盖）里的常用字段：

```yaml
- insert:
    - id: dsh-dot-plugin
      name: 'dsh-dot-plugin'
      config:
        enabled: true
        orchestrator: true          # 管理者模式；false = 旧的研究模式
        agentPreset: standard
        maxWorkers: 4               # 2–8 个 worker 槽位
        workerTimeoutMs: 600000
        executionTools:             # 批准后执行器可用的工具
          - write
          - edit
        systemProactive:            # 默认关闭；只读后台扫描
          enabled: false
          intervalMinutes: 240
          activeWindowHours: 48
          minConfidence: 0.8
          maxMessagesPerDay: 1
          quietHours: '22:00-08:00'
```

| 字段 | 默认值 | 说明 |
|---|---|---|
| `orchestrator` | `true` | 管理者/worker 模式。`false` 恢复为旧的只读研究 Agent。 |
| `maxWorkers` | `4` | 初始 worker 槽位（2–8）。用户调高后的上限会被持久化，重启后仍然有效。 |
| `agentPreset` | `standard` | 管理者、worker 和执行器使用的 Harness 预设。 |
| `workerTimeoutMs` | `600000` | worker 单轮的软超时。 |
| `executionTools` | `write`、`edit` | 批准后执行器可以使用的工具。 |
| `autoApproveLowRisk` | `false` | 保持 `false`：批准权只属于用户。 |
| `systemProactive.enabled` | `false` | 可选的只读后台扫描，覆盖已注册工作区。它只能通知 Dot，不能修改文件、创建任务或控制 Dot 的定时任务。 |
| `systemProactive.intervalMinutes` | `240` | 两次扫描之间的最短间隔。 |
| `systemProactive.activeWindowHours` | `48` | 只检查这个时间窗口内修改过的文件。 |
| `systemProactive.maxWorkspaces` | `20` | 最多检查多少个已注册工作区的近期元数据，用来定位用户当前关注点。 |
| `systemProactive.focusWorkspaces` | `1` | 完成关注度排序后，只深入读取并审查排名最靠前的 N 个（N 即此值）工作区。 |
| `systemProactive.minConfidence` | `0.8` | 低于此置信度的发现会被丢弃。 |
| `systemProactive.maxMessagesPerDay` | `1` | 主动通知的硬上限。 |
| `systemProactive.quietHours` | `22:00-08:00` | 本地时间，该时段内不发送主动通知。 |
| `systemProactive.workspaceAllowlist` | `[]` | 可选的绝对路径；留空表示所有已注册工作区。 |
| `systemProactive.workspaceDenylist` | `[]` | 要排除的路径，可选。 |
| `systemProactive.provider` / `model` | 空 | 可选的廉价模型，用于扫描审查；留空则回退到 `reviewModel` 或默认模型。 |

同样的设置也可以在 **插件 → DSH Dot** 的插件页里修改。该页面通过 Host 的 `configEditor` 服务写入 profile patch，不是单独的配置文件。

状态保存在插件数据目录下：`state.json`（任务、对话、提案、触发器）、`system-proactive.json`（独立的扫描器状态）、`memory/`（事实、画像、日记）、`worker-limit.json`。

## 安全模型

- 管理者不能读文件、跑命令、访问网络，只能管理任务和跟你说话。
- worker 的活动范围被限制在**它自己的任务工作区**内，读、写、跑命令都是。
- 对外操作（发送、发布、付款、删除、邀请、改账户）和跨工作区操作都会变成提案。
- worker 的审批请求由 Dot 复核。安全且与任务一致的操作可以放行一次；不安全的直接拒绝；拿不准的会在 Dot 对话里展示给你。
- 批准 Dot 的提案后，会启动一个**独立的**执行器会话，只带已批准的工具。管理者从不执行。
- `dot_remember` 拒绝密钥，并要求真实、可核验的来源。

## 开发

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test
```

```
src/host/               Host：运行时、状态、任务、HTTP 路由
src/host/orchestrator/  管理者工具、调度器、worker 管理、容量
src/host/memory/        事实、摘要、召回索引
src/host/proactive/     可选的工作区主动性扫描（只读）
src/client.ts           客户端：Dot 对话页
test/                   node --test 测试
specs/                  设计说明
```

提交 PR 时请保持委派边界，以及“Dot 复核 worker / 用户批准 Dot 提案”的审批模型。任何扩大执行权限的改动都需要附带威胁模型说明和测试。完整的基本规则、审查清单和项目不接受的改动，见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

MIT，见 [LICENSE](LICENSE)。

DSH Dot 参考了个人助手类 Agent 的能力模型，但它是独立开源项目，与 OpenAI 无隶属、背书或关联关系。
