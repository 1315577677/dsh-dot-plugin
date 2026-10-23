import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_WORKER_LIMIT, clampWorkerLimit, isWorkerLimit, } from './capacity.js';
const LIMIT_FILE = 'worker-limit.json';
const FILE_VERSION = 1;
/**
 * Durable worker-limit override stored next to state.json.
 *
 * Kept out of state.json on purpose: normalizeV2() rebuilds the state from
 * emptyState() and silently drops unknown top-level fields, and a corrupt
 * state.json falls back to an empty state. A separate file survives both.
 */
export class WorkerLimitStore {
    dataDir;
    log;
    file;
    value;
    fromUser = false;
    loaded;
    writeChain = Promise.resolve();
    constructor(dataDir, fallback = DEFAULT_WORKER_LIMIT, log = () => { }) {
        this.dataDir = dataDir;
        this.log = log;
        this.file = path.join(dataDir, LIMIT_FILE);
        this.value = clampWorkerLimit(fallback);
    }
    get limit() {
        return this.value;
    }
    get source() {
        return this.fromUser ? 'user' : 'config';
    }
    ensureLoaded() {
        this.loaded ??= this.load();
        return this.loaded;
    }
    async load() {
        try {
            const raw = await fs.readFile(this.file, 'utf8');
            const parsed = JSON.parse(raw);
            if (typeof parsed?.limit !== 'number' || !Number.isFinite(parsed.limit)) {
                throw new Error('worker limit file has no numeric limit');
            }
            this.value = clampWorkerLimit(parsed.limit);
            this.fromUser = true;
            if (parsed.limit !== this.value || parsed.version !== FILE_VERSION) {
                this.log('dsh-dot: worker limit file was normalized', { file: this.file, limit: this.value });
            }
        }
        catch (error) {
            if (error.code !== 'ENOENT') {
                this.log('dsh-dot: worker limit file unreadable; using config default', error);
            }
        }
    }
    async set(limit) {
        await this.ensureLoaded();
        if (!isWorkerLimit(limit)) {
            throw new Error(`worker_limit_out_of_range: ${limit}`);
        }
        const previous = this.value;
        const changed = limit !== previous;
        this.value = limit;
        this.fromUser = true;
        const persisted = changed ? await this.persist(limit) : true;
        return { limit, previous, changed, persisted };
    }
    async persist(limit) {
        const payload = `${JSON.stringify({ version: FILE_VERSION, limit, updatedAt: Date.now(), source: 'user' }, null, 2)}\n`;
        const temp = path.join(this.dataDir, `.worker-limit-${process.pid}-${Date.now()}.json`);
        try {
            this.writeChain = this.writeChain.catch(() => { }).then(async () => {
                await fs.mkdir(this.dataDir, { recursive: true });
                await fs.writeFile(temp, payload, 'utf8');
                await fs.rename(temp, this.file);
            });
            await this.writeChain;
            return true;
        }
        catch (error) {
            this.log('dsh-dot: worker limit write failed', error);
            await fs.unlink(temp).catch(() => { });
            return false;
        }
    }
}
