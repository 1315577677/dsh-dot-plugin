import { promises as fs } from 'node:fs';
import { clockLabel, dayKey, loopId, looksLikeSecret, truncate } from './store.js';
const MAX_SEEN = 4000;
const DEFAULT_LIMIT = 300;
const MAX_DETAIL = 120;
const CLOSE_STATUSES = new Set(['done', 'cancelled']);
const OPEN_STATUSES = new Set(['blocked', 'waiting_user']);
export async function autologTasks(state, store, log = () => { }, options = {}) {
    const result = { appended: 0, skipped: 0, loops: 0, failed: 0 };
    try {
        await store.ensureReady();
    }
    catch (error) {
        log('dsh-dot memory: memory directory is not writable', error);
        return { ...result, failed: 1 };
    }
    const seen = await readSeen(store, log);
    const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
    const events = [];
    for (const task of state.tasks) {
        for (const event of task.events ?? []) {
            if (!event || typeof event.id !== 'string')
                continue;
            events.push({ task, event });
        }
    }
    events.sort((a, b) => a.event.at - b.event.at);
    for (const { task, event } of events) {
        if (seen.has(event.id)) {
            result.skipped += 1;
            continue;
        }
        if (result.appended >= limit)
            break;
        try {
            const at = Number.isFinite(event.at) ? event.at : Date.now();
            const day = dayKey(at);
            const line = formatEventLine(task, event, at);
            const written = await store.appendJournal(day, line, `e:${event.id}`);
            if (written)
                result.appended += 1;
            else
                result.skipped += 1;
            seen.add(event.id);
        }
        catch (error) {
            result.failed += 1;
            log(`dsh-dot memory: could not journal event ${event.id}`, error);
        }
    }
    for (const task of state.tasks) {
        try {
            if (OPEN_STATUSES.has(task.status)) {
                await store.upsertLoop({
                    id: loopId(`task:${task.id}`),
                    title: truncate(task.title, 160),
                    blocked_by: task.blockedReason || task.waitingFor || '未指定',
                    next: truncate(task.nextAction, 160),
                    since: dayKey(Number(task.createdAt) || Date.now()),
                    taskId: task.id,
                    status: 'open',
                });
                result.loops += 1;
            }
            else if (CLOSE_STATUSES.has(task.status)) {
                const closed = await store.closeLoopByTask(task.id, truncate(task.verifiedResult || `任务已完成（${task.status}）`, 200));
                if (closed)
                    result.loops += 1;
            }
        }
        catch (error) {
            result.failed += 1;
            log(`dsh-dot memory: could not sync open loop for task ${task.id}`, error);
        }
    }
    try {
        await writeSeen(store, seen);
    }
    catch (error) {
        result.failed += 1;
        log('dsh-dot memory: could not persist autolog dedupe state', error);
    }
    return result;
}
/** One-time copy of the whole existing task history. Same code path, no cap. */
export async function backfillTasks(state, store, log = () => { }) {
    return autologTasks(state, store, log, { limit: 5000 });
}
function formatEventLine(task, event, at) {
    const head = `${clockLabel(at)} [${truncate(task.title, 60)}] ${truncate(event.summary, 180)}`;
    const detail = event.detail ? ` — ${truncate(event.detail, MAX_DETAIL)}` : '';
    const line = `${head}${detail}`;
    if (looksLikeSecret(line)) {
        return `${clockLabel(at)} [${truncate(task.title, 60)}] [已过滤：疑似敏感信息] ${event.type}`;
    }
    return line;
}
async function readSeen(store, log) {
    try {
        const raw = await readText(store.autologFile);
        if (!raw)
            return new Set();
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.seen))
            return new Set();
        return new Set(parsed.seen.filter((id) => typeof id === 'string'));
    }
    catch (error) {
        log('dsh-dot memory: autolog dedupe state unreadable; starting fresh', error);
        return new Set();
    }
}
async function writeSeen(store, seen) {
    const payload = { seen: [...seen].slice(-MAX_SEEN) };
    await store.writeAtomic(store.autologFile, `${JSON.stringify(payload)}\n`);
}
async function readText(target) {
    try {
        return await fs.readFile(target, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return '';
        throw error;
    }
}
