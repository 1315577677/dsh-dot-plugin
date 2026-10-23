import { MemoryIndex } from './index.js';
import { MemoryStore, FACT_KINDS, looksLikeSecret, truncate } from './store.js';
export function createMemory(dir, log = () => { }, validateSource = () => true) {
    const store = new MemoryStore(dir, log);
    const index = new MemoryIndex(store, log);
    return { store, index, validateSource };
}
const SOURCE_HINT = 'source 必填，必须是真实存在的引用：task:<id> | worker:<id> | chat:<id> | journal:<相对路径>#<行号>';
const output = {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [
        { type: 'text', text: JSON.stringify(value, null, 2) },
    ],
};
const genericCall = (title) => (args) => ({
    card: 'generic',
    title,
    kind: 'other',
    rawInput: args,
});
export function registerMemoryTools(agentCtx, memory, agent) {
    const register = (tool) => {
        const execute = tool.execute;
        const safeTool = {
            ...tool,
            execute: async (...args) => plainResult(await execute(...args)),
        };
        agentCtx.effect(() => agentCtx.tools.register(safeTool), `dsh-dot: memory tool ${tool.name}`);
    };
    const onlyDot = (exec, name) => {
        if (!exec.agent || String(exec.agent.id) !== String(agent.id)) {
            throw new Error(`${name} is available only to the Dot supervisor`);
        }
    };
    register({
        name: 'dot_remember',
        description: '记住一条关于用户或工作的事实，写进长期记忆（跨会话持久）。只在有真实来源时调用：用户亲口说的偏好/身份/目标，或已核实的结论。不要凭印象补全，不要记密钥与密码。',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                kind: {
                    type: 'string',
                    enum: ['identity', 'preference', 'goal', 'focus', 'project', 'event', 'decision'],
                    description: '事实类型。用户偏好用 preference，身份用 identity，当前关注用 focus。',
                },
                key: { type: 'string', description: '字段名，如 reply_style / role / current_focus。' },
                value: { type: 'string', description: '一句话，优先用户原话，不超过 200 字。' },
                source: { type: 'string', description: SOURCE_HINT },
                scope: { type: 'string', description: '默认 global；项目相关用 project:<slug>。' },
                confidence: { type: 'number', description: '0-1，用户亲口 0.9，推断最多 0.5。' },
                supersedes: { type: 'string', description: '可选：被这条新事实推翻的旧 fact id。' },
            },
            required: ['kind', 'key', 'value', 'source'],
        },
        output,
        presentCall: genericCall('Remember a fact for later sessions'),
        async execute(args, exec) {
            onlyDot(exec, 'dot_remember');
            const kind = String(args?.kind ?? '');
            if (!FACT_KINDS.includes(kind) || kind === 'tombstone') {
                throw new Error(`invalid_kind: ${String(args?.kind ?? '')}`);
            }
            const key = truncate(String(args?.key ?? ''), 80);
            const value = truncate(String(args?.value ?? ''), 200);
            const source = String(args?.source ?? '').trim();
            if (!key || !value)
                throw new Error('key and value are required');
            if (!source)
                throw new Error(`source_required. ${SOURCE_HINT}`);
            if (!looksLikeSource(source))
                throw new Error(`invalid_source_format: ${source}. ${SOURCE_HINT}`);
            if (!memory.validateSource(source))
                throw new Error(`invalid_source: ${source} 不存在。${SOURCE_HINT}`);
            if (looksLikeSecret(`${key} ${value}`)) {
                throw new Error('secret_blocked: 这条内容疑似包含密钥/密码/token，已拒绝写入。请只记录"已配置完成"这类结论。');
            }
            const confidence = Number(args?.confidence);
            const { fact, deduped } = await memory.store.appendFact({
                kind,
                key,
                value,
                source,
                scope: typeof args?.scope === 'string' ? args.scope : undefined,
                confidence: Number.isFinite(confidence) ? confidence : undefined,
                supersedes: typeof args?.supersedes === 'string' ? args.supersedes : undefined,
            });
            let profileUpdated = false;
            if (kind !== 'event') {
                try {
                    const profile = await memory.store.readProfile();
                    if (profile) {
                        await memory.index.upsertDoc('profile.md', profile);
                        profileUpdated = true;
                    }
                }
                catch {
                    profileUpdated = false;
                }
            }
            return { ok: true, id: fact.id, deduped, profileUpdated };
        },
    });
    register({
        name: 'dot_recall',
        description: '按模糊线索检索长期记忆（跨会话）。适合"去年十月那个邮件自动化"这类指代。只返回证据（文件路径、日期、片段、分数），不下结论；没有命中就照实说没记录。',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                query: { type: 'string', description: '用户原话或关键词。' },
                when: { type: 'string', description: '可选时间线索："去年十月" / "上周" / "2025-10"。' },
                scope: { type: 'string', description: '可选项目 slug，如 dsh-dot-plugin。' },
                limit: { type: 'integer', description: '1-10，默认 5。' },
            },
            required: ['query'],
        },
        output,
        presentCall: genericCall('Search long-term memory'),
        async execute(args, exec) {
            onlyDot(exec, 'dot_recall');
            const query = String(args?.query ?? '').trim();
            if (!query)
                throw new Error('query is required');
            const requestedLimit = Number(args?.limit);
            try {
                const result = await memory.index.query({
                    query,
                    when: typeof args?.when === 'string' ? args.when : undefined,
                    scope: typeof args?.scope === 'string' ? args.scope : undefined,
                    limit: Number.isFinite(requestedLimit) ? requestedLimit : undefined,
                });
                if (result.hits.length === 0) {
                    return {
                        ok: true,
                        ...result,
                        note: '长期记忆里没有命中。不要编造：直接告诉用户没有相关记录，必要时问他更多线索。',
                    };
                }
                return { ok: true, ...result };
            }
            catch (error) {
                return {
                    ok: false,
                    error: `recall_failed: ${error instanceof Error ? error.message : String(error)}`,
                    hits: [],
                };
            }
        },
    });
}
function looksLikeSource(source) {
    return /^(task|worker|chat|journal):[^\s]{1,200}$/.test(source);
}
function plainResult(value) {
    if (value === undefined)
        return null;
    return JSON.parse(JSON.stringify(value));
}
