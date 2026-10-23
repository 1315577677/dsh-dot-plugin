import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
/**
 * File-backed memory for DSH Dot.
 *
 * Design rules (see memory-architecture.md):
 *  - facts.jsonl is the only append-only source of truth for the user profile;
 *    profile.md is a rendered view, never hand-edited.
 *  - journal is one Markdown file per local day, append-only, deduplicated by a
 *    hidden marker so a replayed task event never writes twice.
 *  - every write is atomic (temp file + rename) and every failure is swallowed
 *    by the caller: memory must never break the user-facing reply path.
 *  - no database, no dependency: node:fs / node:path / node:crypto only.
 */
export const MEMORY_DIR_NAME = 'memory';
export const MAX_FACT_VALUE_CHARS = 200;
export const MAX_FACT_LINE_BYTES = 400;
export const MAX_PROFILE_BYTES = 8 * 1024;
export const MAX_JOURNAL_LINES = 120;
export const MAX_LOOPS = 30;
const FACT_ID_SCAN = 500;
export const FACT_KINDS = [
    'identity',
    'preference',
    'goal',
    'focus',
    'project',
    'event',
    'decision',
    'tombstone',
];
/** Secret-ish strings we refuse to persist. Basic filter, not a guarantee. */
const SECRET_PATTERNS = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bsk-[A-Za-z0-9_-]{16,}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    /\bAKIA[0-9A-Z]{12,}\b/,
    /\bBearer\s+[A-Za-z0-9._-]{20,}\b/i,
    /\b(password|passwd|secret|token|api[_\- ]?key)\b\s*[:=：]\s*\S{6,}/i,
    /\b\d{16,19}\b/,
    /\b\d{17}[\dXx]\b/,
];
export function looksLikeSecret(text) {
    if (!text)
        return false;
    return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}
export function factId(kind, scope, key, value) {
    const normalized = `${kind}|${scope}|${key.trim()}|${value.trim().replace(/\s+/g, ' ').toLowerCase()}`;
    return `fact_${createHash('sha1').update(normalized).digest('hex').slice(0, 12)}`;
}
export function dayKey(at) {
    const date = at instanceof Date ? at : new Date(at);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
export function isDayKey(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value);
}
export function clockLabel(at) {
    const date = at instanceof Date ? at : new Date(at);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
export function truncate(text, max) {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
    return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1))}…`;
}
function clamp01(value, fallback) {
    if (!Number.isFinite(value))
        return fallback;
    if (value < 0)
        return 0;
    if (value > 1)
        return 1;
    return value;
}
/** Very small YAML front-matter reader: `key: value` lines only, no nesting. */
export function splitFrontMatter(raw) {
    const text = String(raw ?? '');
    if (!text.startsWith('---'))
        return { meta: {}, body: text };
    const end = text.indexOf('\n---', 3);
    if (end < 0)
        return { meta: {}, body: text };
    const head = text.slice(3, end);
    const after = text.indexOf('\n', end + 4);
    const body = after < 0 ? '' : text.slice(after + 1);
    const meta = {};
    for (const line of head.split('\n')) {
        const match = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
        if (!match)
            continue;
        meta[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
    }
    return { meta, body };
}
export class MemoryStore {
    log;
    dir;
    readyPromise;
    factIdCache;
    constructor(dir, log = () => { }) {
        this.log = log;
        this.dir = path.resolve(dir);
    }
    get factsFile() {
        return path.join(this.dir, 'facts.jsonl');
    }
    get profileFile() {
        return path.join(this.dir, 'profile.md');
    }
    get loopsFile() {
        return path.join(this.dir, 'open-loops.json');
    }
    get loopsViewFile() {
        return path.join(this.dir, 'open-loops.md');
    }
    get autologFile() {
        return path.join(this.dir, '.autolog.json');
    }
    get journalDir() {
        return path.join(this.dir, 'journal');
    }
    get projectsDir() {
        return path.join(this.dir, 'projects');
    }
    get rollupsDir() {
        return path.join(this.dir, 'rollups');
    }
    get trashDir() {
        return path.join(this.dir, '.trash');
    }
    journalFile(day) {
        const [year, month] = day.split('-');
        return path.join(this.journalDir, year, month, `${day}.md`);
    }
    ensureReady() {
        this.readyPromise ??= this.init();
        return this.readyPromise;
    }
    async init() {
        await fs.mkdir(this.dir, { recursive: true });
        await fs.mkdir(this.journalDir, { recursive: true });
        await fs.mkdir(this.projectsDir, { recursive: true });
        await fs.mkdir(this.rollupsDir, { recursive: true });
        await fs.mkdir(this.trashDir, { recursive: true });
    }
    // ---------------------------------------------------------------- facts ---
    async appendFact(input) {
        await this.ensureReady();
        const value = truncate(input.value, MAX_FACT_VALUE_CHARS);
        if (!value)
            throw new Error('fact_value_required');
        const scope = (input.scope ?? 'global').trim() || 'global';
        const key = truncate(input.key, 80);
        if (!key)
            throw new Error('fact_key_required');
        const fact = {
            id: factId(input.kind, scope, key, value),
            ts: input.ts ?? new Date().toISOString(),
            kind: input.kind,
            scope,
            key,
            value,
            confidence: clamp01(Number(input.confidence), 0.7),
            source: truncate(input.source, 160),
            ...(input.supersedes ? { supersedes: input.supersedes } : {}),
        };
        const ids = await this.knownFactIds();
        if (ids.has(fact.id))
            return { fact, deduped: true };
        let line = JSON.stringify(fact);
        if (Buffer.byteLength(line, 'utf8') > MAX_FACT_LINE_BYTES) {
            fact.value = truncate(fact.value, 80);
            line = JSON.stringify(fact);
        }
        await fs.appendFile(this.factsFile, `${line}\n`, 'utf8');
        ids.add(fact.id);
        await this.renderProfile();
        return { fact, deduped: false };
    }
    async knownFactIds() {
        if (this.factIdCache)
            return this.factIdCache;
        const facts = await this.readFacts();
        this.factIdCache = new Set(facts.map((fact) => fact.id));
        return this.factIdCache;
    }
    async readFacts() {
        await this.ensureReady();
        let raw = '';
        try {
            raw = await fs.readFile(this.factsFile, 'utf8');
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return [];
            throw error;
        }
        const facts = [];
        for (const line of raw.split('\n')) {
            if (!line.trim())
                continue;
            try {
                const parsed = JSON.parse(line);
                if (!parsed || typeof parsed.id !== 'string' || typeof parsed.key !== 'string')
                    continue;
                if (typeof parsed.value !== 'string' || typeof parsed.kind !== 'string')
                    continue;
                facts.push({
                    id: parsed.id,
                    ts: typeof parsed.ts === 'string' ? parsed.ts : new Date(0).toISOString(),
                    kind: parsed.kind,
                    scope: typeof parsed.scope === 'string' ? parsed.scope : 'global',
                    key: parsed.key,
                    value: parsed.value,
                    confidence: clamp01(Number(parsed.confidence), 0.5),
                    source: typeof parsed.source === 'string' ? parsed.source : 'unknown',
                    ...(typeof parsed.supersedes === 'string' ? { supersedes: parsed.supersedes } : {}),
                });
            }
            catch {
                this.log('dsh-dot memory: skipped one malformed fact line');
            }
        }
        return facts;
    }
    /** Render profile.md from facts.jsonl and return the rendered text. */
    async renderProfile() {
        await this.ensureReady();
        const facts = await this.readFacts();
        const text = renderProfileMarkdown(facts);
        await this.writeAtomic(this.profileFile, text);
        return text;
    }
    async readProfile() {
        try {
            return await fs.readFile(this.profileFile, 'utf8');
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return '';
            throw error;
        }
    }
    // -------------------------------------------------------------- journal ---
    async appendJournal(day, text, key) {
        if (!isDayKey(day))
            throw new Error(`invalid_day: ${day}`);
        await this.ensureReady();
        const line = truncate(text, 400);
        if (!line)
            return false;
        const file = this.journalFile(day);
        const markerKey = key ? truncate(key, 120) : createHash('sha1').update(line).digest('hex').slice(0, 12);
        const marker = `<!-- k:${markerKey} -->`;
        let current = '';
        try {
            current = await fs.readFile(file, 'utf8');
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
        if (current.includes(marker))
            return false;
        const lines = current ? current.split('\n').filter((entry) => entry.startsWith('- ')) : [];
        if (lines.length >= MAX_JOURNAL_LINES) {
            this.log(`dsh-dot memory: journal ${day} reached its line cap; entry skipped`);
            return false;
        }
        if (!current) {
            const header = [
                '---',
                `date: ${day}`,
                `created: ${new Date().toISOString()}`,
                '---',
                `# ${day}`,
                '',
                '',
            ].join('\n');
            await this.writeAtomic(file, header);
        }
        await fs.appendFile(file, `- ${line} ${marker}\n`, 'utf8');
        return true;
    }
    async readJournal(day) {
        try {
            return await fs.readFile(this.journalFile(day), 'utf8');
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return '';
            throw error;
        }
    }
    async journalHeadlines(day, max = 3) {
        const raw = await this.readJournal(day);
        if (!raw)
            return [];
        const out = [];
        for (const line of raw.split('\n')) {
            if (!line.startsWith('- '))
                continue;
            out.push(line.replace(/<!--.*?-->/g, '').replace(/^- /, '').trim());
            if (out.length >= max)
                break;
        }
        return out;
    }
    async recentJournalDays(limit = 7) {
        await this.ensureReady();
        const days = [];
        let years = [];
        try {
            years = (await fs.readdir(this.journalDir)).filter((name) => /^\d{4}$/.test(name));
        }
        catch {
            return [];
        }
        for (const year of years) {
            const yearDir = path.join(this.journalDir, year);
            let months = [];
            try {
                months = (await fs.readdir(yearDir)).filter((name) => /^\d{2}$/.test(name));
            }
            catch {
                continue;
            }
            for (const month of months) {
                let files = [];
                try {
                    files = await fs.readdir(path.join(yearDir, month));
                }
                catch {
                    continue;
                }
                for (const file of files) {
                    const match = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(file);
                    if (match)
                        days.push(match[1]);
                }
            }
        }
        days.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
        return [...new Set(days)].slice(0, limit);
    }
    /** All Markdown docs the index should know about, as memory-relative paths. */
    async listDocs() {
        await this.ensureReady();
        const docs = [];
        for (const day of await this.recentJournalDays(4000)) {
            docs.push(path.relative(this.dir, this.journalFile(day)).split(path.sep).join('/'));
        }
        for (const dir of [this.projectsDir, this.rollupsDir]) {
            let files = [];
            try {
                files = await fs.readdir(dir);
            }
            catch {
                continue;
            }
            for (const file of files) {
                if (!file.endsWith('.md'))
                    continue;
                docs.push(path.relative(this.dir, path.join(dir, file)).split(path.sep).join('/'));
            }
        }
        if (await this.exists(this.profileFile))
            docs.push('profile.md');
        if (await this.exists(this.loopsViewFile))
            docs.push('open-loops.md');
        return docs;
    }
    async readDoc(relative) {
        const target = path.resolve(this.dir, relative);
        if (target !== this.dir && !target.startsWith(this.dir + path.sep))
            throw new Error('memory_path_escape');
        try {
            const raw = await fs.readFile(target, 'utf8');
            return raw.length > 96_000 ? raw.slice(0, 96_000) : raw;
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return '';
            throw error;
        }
    }
    // ---------------------------------------------------------------- loops ---
    async readLoops() {
        await this.ensureReady();
        try {
            const raw = await fs.readFile(this.loopsFile, 'utf8');
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed))
                return [];
            return parsed
                .filter((entry) => !!entry && typeof entry === 'object' && typeof entry.id === 'string')
                .map((entry) => ({
                id: entry.id,
                title: truncate(String(entry.title ?? ''), 160),
                blocked_by: truncate(String(entry.blocked_by ?? '未指定'), 80),
                next: truncate(String(entry.next ?? '待定'), 160),
                since: isDayKey(String(entry.since ?? '')) ? String(entry.since) : dayKey(Date.now()),
                status: entry.status === 'closed' ? 'closed' : 'open',
                ...(typeof entry.taskId === 'string' ? { taskId: entry.taskId } : {}),
                ...(typeof entry.evidence === 'string' ? { evidence: truncate(entry.evidence, 200) } : {}),
                ...(typeof entry.closed_at === 'string' ? { closed_at: entry.closed_at } : {}),
            }));
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return [];
            this.log('dsh-dot memory: could not read open loops', error);
            return [];
        }
    }
    async upsertLoop(input) {
        await this.ensureReady();
        const loops = await this.readLoops();
        const id = input.id ?? loopId(input.title);
        const existing = loops.find((loop) => loop.id === id);
        const next = {
            id,
            title: truncate(input.title, 160),
            blocked_by: truncate(input.blocked_by ?? existing?.blocked_by ?? '未指定', 80),
            next: truncate(input.next ?? existing?.next ?? '待定', 160),
            since: existing?.since ?? input.since ?? dayKey(Date.now()),
            status: input.status ?? existing?.status ?? 'open',
            ...(input.taskId ?? existing?.taskId ? { taskId: input.taskId ?? existing?.taskId } : {}),
            ...(input.evidence ?? existing?.evidence ? { evidence: input.evidence ?? existing?.evidence } : {}),
            ...(input.closed_at ?? existing?.closed_at ? { closed_at: input.closed_at ?? existing?.closed_at } : {}),
        };
        const merged = existing
            ? loops.map((loop) => (loop.id === id ? next : loop))
            : [...loops, next].slice(-MAX_LOOPS * 4);
        await this.writeAtomic(this.loopsFile, `${JSON.stringify(merged, null, 2)}\n`);
        await this.writeAtomic(this.loopsViewFile, renderLoopsMarkdown(merged));
        return next;
    }
    async closeLoop(id, evidence) {
        const loops = await this.readLoops();
        const target = loops.find((loop) => loop.id === id && loop.status === 'open');
        if (!target)
            return undefined;
        return this.upsertLoop({
            ...target,
            status: 'closed',
            evidence: truncate(evidence, 200),
            closed_at: new Date().toISOString(),
        });
    }
    async closeLoopByTask(taskId, evidence) {
        const loops = await this.readLoops();
        const target = loops.find((loop) => loop.taskId === taskId && loop.status === 'open');
        if (!target)
            return undefined;
        return this.closeLoop(target.id, evidence);
    }
    // -------------------------------------------------------------- projects ---
    async projectSummaries(limit = 5) {
        await this.ensureReady();
        let files = [];
        try {
            files = await fs.readdir(this.projectsDir);
        }
        catch {
            return [];
        }
        const out = [];
        for (const file of files) {
            if (!file.endsWith('.md'))
                continue;
            const raw = await this.readDoc(`projects/${file}`);
            if (!raw)
                continue;
            const { meta, body } = splitFrontMatter(raw);
            const slug = meta.slug || file.replace(/\.md$/, '');
            const last = meta.last_active || meta.date || '';
            const summary = body
                .split('\n')
                .map((line) => line.replace(/^#+\s*/, '').trim())
                .find((line) => line.length > 0) ?? '';
            out.push({
                slug,
                title: meta.title || slug,
                last: isDayKey(last) ? last : '',
                summary: truncate(summary, 90),
            });
        }
        out.sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
        return out.slice(0, limit);
    }
    // ------------------------------------------------------------------ misc ---
    async writeAtomic(target, content) {
        const dir = path.dirname(target);
        await fs.mkdir(dir, { recursive: true });
        const temp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
        try {
            await fs.writeFile(temp, content, 'utf8');
            await fs.rename(temp, target);
        }
        catch (error) {
            await fs.unlink(temp).catch(() => { });
            throw error;
        }
    }
    async exists(target) {
        try {
            await fs.stat(target);
            return true;
        }
        catch {
            return false;
        }
    }
}
export function loopId(title) {
    return `loop_${createHash('sha1').update(truncate(title, 120)).digest('hex').slice(0, 10)}`;
}
export function renderLoopsMarkdown(loops) {
    const open = loops.filter((loop) => loop.status === 'open');
    const closed = loops.filter((loop) => loop.status !== 'open').slice(-20);
    const lines = [
        '---',
        `generated_at: ${new Date().toISOString()}`,
        `open: ${open.length}`,
        '---',
        '# 未完成事项（尾巴）',
        '',
        '| 事项 | 卡在 | 下一步 | 起 | id |',
        '|---|---|---|---|---|',
        ...open.map((loop) => `| ${escapeCell(loop.title)} | ${escapeCell(loop.blocked_by)} | ${escapeCell(loop.next)} | ${loop.since} | ${loop.id} |`),
    ];
    if (closed.length > 0) {
        lines.push('', '## 已关闭', '');
        for (const loop of closed) {
            lines.push(`- ${loop.title}（${loop.closed_at ?? ''}${loop.evidence ? `：${loop.evidence}` : ''}）`);
        }
    }
    return `${lines.join('\n')}\n`;
}
function escapeCell(value) {
    return String(value ?? '').replace(/\|/g, '/').replace(/\n/g, ' ');
}
function renderProfileMarkdown(facts) {
    const superseded = new Set();
    for (const fact of facts) {
        if (fact.supersedes)
            superseded.add(fact.supersedes);
    }
    const live = facts.filter((fact) => !superseded.has(fact.id));
    const winners = new Map();
    for (const fact of live) {
        if (fact.kind === 'tombstone' || fact.kind === 'event')
            continue;
        const groupKey = `${fact.scope}||${fact.kind}||${fact.key}`;
        const bucket = winners.get(groupKey) ?? [];
        bucket.push(fact);
        winners.set(groupKey, bucket);
    }
    const sections = [
        { title: '身份', items: [] },
        { title: '偏好', items: [] },
        { title: '目标', items: [] },
        { title: '当前关注', items: [] },
        { title: '项目', items: [] },
        { title: '较早的决定', items: [] },
        { title: '冲突', items: [] },
    ];
    const sectionFor = (kind) => {
        if (kind === 'identity')
            return sections[0];
        if (kind === 'preference')
            return sections[1];
        if (kind === 'goal')
            return sections[2];
        if (kind === 'focus')
            return sections[3];
        if (kind === 'project')
            return sections[4];
        return sections[5];
    };
    for (const bucket of winners.values()) {
        bucket.sort((a, b) => {
            if (b.confidence !== a.confidence)
                return b.confidence - a.confidence;
            return a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0;
        });
        const winner = bucket[0];
        const line = `- \`${winner.key}\`: ${winner.value} (conf ${winner.confidence.toFixed(2)}, ${shortDate(winner.ts)}, ${winner.source})`;
        sectionFor(winner.kind).items.push(line);
        const runnerUp = bucket[1];
        if (runnerUp &&
            runnerUp.confidence >= winner.confidence - 0.15 &&
            daysBetween(runnerUp.ts, winner.ts) <= 30) {
            sections[6].items.push(`- \`${winner.key}\`：两条不一致 —— "${winner.value}" (${shortDate(winner.ts)}) vs "${runnerUp.value}" (${shortDate(runnerUp.ts)})`);
        }
    }
    const header = [
        '---',
        `generated_at: ${new Date().toISOString()}`,
        `fact_count: ${facts.length}`,
        '---',
        '# 用户画像',
        '',
        '> 自动生成：源数据 `facts.jsonl`。不要手改本文件，改它会被下次渲染覆盖。',
        '',
    ];
    const render = () => {
        const lines = [...header];
        for (const section of sections) {
            if (section.items.length === 0)
                continue;
            lines.push(`## ${section.title}`, '', ...section.items, '');
        }
        if (sections.every((section) => section.items.length === 0)) {
            lines.push('（暂无画像事实。用 `dot_remember` 记录用户的身份、偏好或目标。）', '');
        }
        return lines.join('\n');
    };
    let text = render();
    let guard = 0;
    while (Buffer.byteLength(text, 'utf8') > MAX_PROFILE_BYTES && guard < 200) {
        guard += 1;
        const droppable = sections
            .filter((section) => section.items.length > 1)
            .sort((a, b) => b.items.length - a.items.length)[0];
        if (!droppable)
            break;
        droppable.items.pop();
        text = render();
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_PROFILE_BYTES) {
        text = `${text.slice(0, MAX_PROFILE_BYTES - 80)}\n…（画像超限已截断）\n`;
    }
    return text;
}
function shortDate(ts) {
    const time = Date.parse(ts);
    if (!Number.isFinite(time))
        return String(ts).slice(0, 10);
    return dayKey(time);
}
function daysBetween(a, b) {
    const left = Date.parse(a);
    const right = Date.parse(b);
    if (!Number.isFinite(left) || !Number.isFinite(right))
        return Number.MAX_SAFE_INTEGER;
    return Math.abs(right - left) / 86_400_000;
}
/** Kept for the one-time backfill and for tests. */
export const MEMORY_LIMITS = {
    FACT_ID_SCAN,
    MAX_FACT_VALUE_CHARS,
    MAX_FACT_LINE_BYTES,
    MAX_PROFILE_BYTES,
    MAX_JOURNAL_LINES,
    MAX_LOOPS,
};
