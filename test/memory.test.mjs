import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// These tests run against the built output: `pnpm build` first.
import { MemoryStore, dayKey, looksLikeSecret } from '../lib/memory/store.js'
import { MemoryIndex, parseTimeRange, tokenize } from '../lib/memory/index.js'
import { autologTasks } from '../lib/memory/autolog.js'
import { buildStartupDigest, clipToBudget } from '../lib/memory/digest.js'

async function tempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dot-memory-'))
  return new MemoryStore(path.join(dir, 'memory'))
}

async function putJournal(store, day, text) {
  const ok = await store.appendJournal(day, text, `k:${text}`)
  assert.equal(ok, true)
}

test('store: appending a fact renders profile.md and is idempotent', async () => {
  const store = await tempStore()
  const first = await store.appendFact({
    kind: 'preference',
    key: 'reply_style',
    value: '回复要短，先给结论',
    source: 'chat:chat_test1',
    confidence: 0.9,
  })
  assert.equal(first.deduped, false)
  assert.match(first.fact.id, /^fact_[0-9a-f]{12}$/)

  const second = await store.appendFact({
    kind: 'preference',
    key: 'reply_style',
    value: '回复要短，先给结论',
    source: 'chat:chat_test1',
    confidence: 0.9,
  })
  assert.equal(second.deduped, true)
  assert.equal(second.fact.id, first.fact.id)

  const factsRaw = await fs.readFile(store.factsFile, 'utf8')
  assert.equal(factsRaw.trim().split('\n').length, 1)

  const profile = await store.readProfile()
  assert.match(profile, /用户画像/)
  assert.match(profile, /reply_style/)
  assert.match(profile, /回复要短/)
  assert.match(profile, /chat:chat_test1/)
  assert.match(profile, /conf 0\.90/)
})

test('store: profile keeps the higher confidence winner and flags close conflicts', async () => {
  const store = await tempStore()
  await store.appendFact({
    kind: 'focus',
    key: 'current_focus',
    value: '长期记忆',
    source: 'chat:chat_a',
    confidence: 0.8,
    ts: '2026-10-01T10:00:00.000Z',
  })
  await store.appendFact({
    kind: 'focus',
    key: 'current_focus',
    value: 'UI 面板',
    source: 'chat:chat_b',
    confidence: 0.78,
    ts: '2026-10-20T10:00:00.000Z',
  })
  const profile = await store.readProfile()
  assert.match(profile, /## 冲突/)
})

test('store: tolerant of malformed jsonl lines', async () => {
  const store = await tempStore()
  await store.ensureReady()
  await store.appendFact({ kind: 'identity', key: 'role', value: '开发者', source: 'chat:chat_c' })
  await fs.appendFile(store.factsFile, 'not-json-at-all\n{"broken":\n', 'utf8')
  const facts = await store.readFacts()
  assert.equal(facts.length, 1)
  const profile = await store.readProfile()
  assert.match(profile, /开发者/)
})

test('store: journal append deduplicates by key and keeps one line per event', async () => {
  const store = await tempStore()
  const day = '2026-10-22'
  const first = await store.appendJournal(day, '10:00 做了 A', 'e:event_1')
  const again = await store.appendJournal(day, '10:00 做了 A', 'e:event_1')
  assert.equal(first, true)
  assert.equal(again, false)
  const raw = await store.readJournal(day)
  assert.equal(raw.split('\n').filter((line) => line.startsWith('- ')).length, 1)
  assert.match(raw, /event_1/)
})

test('index: keyword hit returns path, date and snippet', async () => {
  const store = await tempStore()
  await putJournal(store, '2025-10-14', '把邮件自动化改成每周一跑一次，脚本在 tools/mail.sh')
  await putJournal(store, '2026-10-22', '优化 Dot 聊天面板 UI，改了 client.ts 的样式')

  const index = new MemoryIndex(store)
  await index.refresh()
  assert.equal(index.size, 2)

  const result = await index.query({ query: '邮件自动化', now: Date.parse('2026-10-23T12:00:00') })
  assert.ok(result.hits.length >= 1)
  const hit = result.hits[0]
  assert.equal(hit.path, 'journal/2025/10/2025-10-14.md')
  assert.equal(hit.date, '2025-10-14')
  assert.match(hit.snippet, /邮件自动化/)
  assert.ok(hit.score > 0)
})

test('index: time window filters and widens when nothing matches', async () => {
  const store = await tempStore()
  await putJournal(store, '2025-10-14', '邮件自动化上线')
  await putJournal(store, '2026-10-22', '邮件模板改文案')

  const index = new MemoryIndex(store)
  await index.refresh()
  const now = Date.parse('2026-10-23T12:00:00')

  const range = parseTimeRange('去年十月', now)
  assert.ok(range)
  assert.equal(range.from, '2025-10-01')
  assert.equal(range.to, '2025-10-31')
  assert.equal(range.granularity, 'month')

  const exact = await index.query({ query: '那个邮件自动化', when: '去年十月', now })
  assert.equal(exact.relaxed, 0)
  assert.equal(exact.hits[0].date, '2025-10-14')

  // Wrong month: the exact window is empty, so the search widens to the year.
  const wrongMonth = await index.query({ query: '邮件自动化', when: '2026-03', now })
  assert.equal(wrongMonth.relaxed, 1)
  assert.ok(wrongMonth.hits.every((hit) => hit.date.startsWith('2026')))

  const relaxed = await index.query({ query: '邮件自动化', when: '2025-03', now })
  assert.equal(relaxed.relaxed, 1)
  assert.equal(relaxed.hits[0].date, '2025-10-14')
})

test('index: unknown topic returns no hits instead of inventing one', async () => {
  const store = await tempStore()
  await putJournal(store, '2026-10-22', '优化 Dot 聊天面板 UI')
  const index = new MemoryIndex(store)
  await index.refresh()
  const result = await index.query({ query: '招聘方案', now: Date.parse('2026-10-23T12:00:00') })
  assert.deepEqual(result.hits, [])
  assert.equal(result.relaxed, 3)
})

test('autolog: task events are journaled once and open loops follow status', async () => {
  const store = await tempStore()
  const at = new Date(2025, 9, 14, 10, 30, 0).getTime()
  const state = {
    version: 2,
    proposals: [],
    tasks: [
      {
        id: 'task_blocked',
        title: '邮件自动化',
        request: '把邮件自动化',
        status: 'blocked',
        priority: 'normal',
        createdAt: at,
        updatedAt: at,
        plan: 'p',
        nextAction: '等用户给 SMTP 账号',
        blockedReason: '缺 SMTP 凭据',
        artifacts: [],
        events: [
          { id: 'event_1', at, actor: 'dot', type: 'created', summary: '任务创建' },
          { id: 'event_2', at: at + 60000, actor: 'worker', type: 'worker_failed', summary: 'worker 失败' },
        ],
        proposalIds: [],
      },
      {
        id: 'task_done',
        title: '旧任务',
        request: '旧任务',
        status: 'done',
        priority: 'normal',
        createdAt: at,
        updatedAt: at,
        plan: 'p',
        nextAction: 'n',
        artifacts: [],
        verifiedResult: '已交付',
        events: [],
        proposalIds: [],
      },
    ],
    workers: [],
    chatMessages: [],
    triggers: [],
    pendingAuto: [],
  }

  const first = await autologTasks(state, store)
  assert.equal(first.appended, 2)
  const second = await autologTasks(state, store)
  assert.equal(second.appended, 0)
  assert.ok(second.skipped >= 2)

  const raw = await store.readJournal(dayKey(at))
  assert.equal(raw.split('\n').filter((line) => line.startsWith('- ')).length, 2)

  const loops = await store.readLoops()
  assert.equal(loops.filter((loop) => loop.status === 'open').length, 1)
  assert.match(loops[0].blocked_by, /SMTP/)
})

test('autolog: completed task closes its own loop', async () => {
  const store = await tempStore()
  const at = new Date(2026, 9, 20, 9, 0, 0).getTime()
  const base = {
    request: 'r',
    priority: 'normal',
    createdAt: at,
    updatedAt: at,
    plan: 'p',
    nextAction: 'n',
    artifacts: [],
    events: [],
    proposalIds: [],
  }
  const blocked = { ...base, id: 'task_x', title: '等审批的任务', status: 'blocked', blockedReason: '等用户批' }
  const state1 = { version: 2, proposals: [], tasks: [blocked], workers: [], chatMessages: [], triggers: [], pendingAuto: [] }
  await autologTasks(state1, store)
  assert.equal((await store.readLoops()).filter((loop) => loop.status === 'open').length, 1)

  const done = { ...blocked, status: 'done', verifiedResult: '用户已批，已执行' }
  const state2 = { ...state1, tasks: [done] }
  await autologTasks(state2, store)
  assert.equal((await store.readLoops()).filter((loop) => loop.status === 'open').length, 0)
})

test('digest: startup digest carries profile, loops and recent day headlines', async () => {
  const store = await tempStore()
  await store.appendFact({
    kind: 'preference',
    key: 'reply_style',
    value: '先给结论',
    source: 'chat:chat_d',
    confidence: 0.9,
  })
  const at = new Date(2026, 9, 22, 15, 0, 0).getTime()
  await store.appendJournal(dayKey(at), '15:00 完成了记忆 MVP 的 store.ts', 'e:e1')
  await store.upsertLoop({ title: '记忆补丁未合并', blocked_by: '等风格补丁', next: '先打 style' })

  const index = new MemoryIndex(store)
  await index.refresh()
  const digest = await buildStartupDigest(store, index, { now: at })
  assert.match(digest, /长期记忆/)
  assert.match(digest, /先给结论/)
  assert.match(digest, /记忆补丁未合并/)
  assert.match(digest, /store\.ts/)
  assert.ok(digest.length <= 3800)
})

test('digest: empty memory produces no prompt block', async () => {
  const store = await tempStore()
  const index = new MemoryIndex(store)
  await index.refresh()
  assert.equal(await buildStartupDigest(store, index), '')
})

test('privacy: secret-looking strings are detected, normal text is not', () => {
  assert.equal(looksLikeSecret('sk-abcdefghijklmnop123456'), true)
  assert.equal(looksLikeSecret('password: hunter2hunter2'), true)
  assert.equal(looksLikeSecret('ghp_0123456789abcdefghijABCDEFGHIJ'), true)
  assert.equal(looksLikeSecret('账号密码已经配好了'), false)
  assert.equal(looksLikeSecret('把邮件自动化改成每周一跑'), false)
})

test('tokenize and clip helpers behave', () => {
  assert.ok(tokenize('邮件自动化').includes('邮件'))
  assert.ok(tokenize('Fix the SMTP config').includes('smtp'))
  assert.equal(clipToBudget('short', 100), 'short')
  assert.ok(clipToBudget('x'.repeat(500), 100).length <= 130)
})
