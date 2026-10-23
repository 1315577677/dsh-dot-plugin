import path from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { registerDotCommand } from './commands.js';
import { startHttpBridge } from './http.js';
import { Reviewer } from './reviewer.js';
import { DotRuntime } from './runtime.js';
import { StateStore } from './state.js';
import { DEFAULT_EXECUTION_TOOLS, DEFAULT_READ_ONLY_TOOLS, DEFAULT_RULES, } from './types.js';
/** Loader row id, dsh.plugin.json id, and this export must stay identical. */
export const name = 'dsh-dot-plugin';
export const inject = ['agents', 'sessions', 'tools', 'webServer'];
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
/** Schemastery config exposed through the profile patch. */
export const Config = z.object({
    enabled: z.boolean().default(true),
    orchestrator: z.boolean().default(true),
    initialDelayMs: z.number().step(1).min(1_000).default(20_000),
    researchIntervalMs: z.number().step(1).min(60_000).default(300_000),
    sources: z
        .array(z.object({
        id: z.string(),
        kind: z.string(),
        label: z.string(),
        path: z.string().default(''),
        url: z.string().default(''),
        tools: z.array(z.string()).default([]),
        enabled: z.boolean().default(true),
    }))
        .default([]),
    readOnlyTools: z.array(z.string()).default(DEFAULT_READ_ONLY_TOOLS),
    executionTools: z.array(z.string()).default(DEFAULT_EXECUTION_TOOLS),
    reviewModel: z.string().default(''),
    reviewProvider: z.string().default(''),
    reviewTimeoutMs: z.number().step(1).min(1_000).max(120_000).default(20_000),
    rules: z
        .array(z.object({
        action_pattern: z.string(),
        decision: z.string(),
    }))
        .default(DEFAULT_RULES),
    autoApproveLowRisk: z.boolean().default(false),
    dotWorkspace: z.string().default(''),
    maxProposalsPerRound: z.number().step(1).min(1).max(10).default(3),
    researchPrompt: z.string().default(''),
    agentPreset: z.string().default('standard'),
    workerTimeoutMs: z.number().step(1).min(10_000).default(900_000),
    workerMaxTurns: z.number().step(1).min(1).max(10).default(3),
    workerStageMaxBytes: z.number().step(1).min(1024).max(10_485_760).default(1_048_576),
    maxWorkers: z.number().step(1).min(2).max(8).default(4),
    stateDir: z.string().default(''),
});
/**
 * Real Dot:
 *  - a persistent, top-level Dot Agent/Session;
 *  - a read-only research pass with a scoped tool allowlist + monotonic guard;
 *  - proposals recorded by `dot_propose_action`, independently risk-reviewed;
 *  - approved execution in a separate Agent turn with only the approved tools.
 */
export function apply(ctx, config = {}) {
    const resolved = resolveConfig(config);
    const log = (message, ...args) => ctx.logger?.info?.(message, ...args);
    const warn = (message, ...args) => ctx.logger?.warn?.(message, ...args);
    const dataDir = resolved.stateDir
        ? path.resolve(expandHome(resolved.stateDir))
        : path.resolve(moduleDir, '..', 'data');
    const store = new StateStore(dataDir, warn);
    const reviewer = new Reviewer(ctx, resolved);
    const runtime = new DotRuntime(ctx, resolved, store, reviewer, warn);
    runtime.start();
    startHttpBridge(ctx, runtime, warn);
    registerDotCommand(ctx, runtime, log);
    const service = {
        version: 2,
        getState: () => runtime.getClientState(),
        getSessionId: () => runtime.sessionId,
        runResearch: (reason = 'service') => runtime.runResearch(reason),
        fireTrigger: (triggerId, payload) => runtime.fireTrigger(triggerId, payload),
        listSchedules: () => runtime.listSchedules(),
        getStateFilePath: () => store.file,
    };
    ctx.effect(() => ctx.provide('dshDot', service), 'dsh-dot: Host service');
    log(`dsh-dot: starting Dot runtime · data=${dataDir} · sources=${resolved.sources.length} · read-only=${resolved.readOnlyTools.join(',')}`);
}
export function resolveConfig(input = {}) {
    const sources = normalizeSources(input.sources);
    const readOnlyTools = normalizeToolNames(input.readOnlyTools, DEFAULT_READ_ONLY_TOOLS);
    const executionTools = normalizeToolNames(input.executionTools, DEFAULT_EXECUTION_TOOLS);
    const rules = normalizeRules(input.rules);
    return {
        enabled: input.enabled ?? true,
        orchestrator: input.orchestrator ?? true,
        initialDelayMs: whole(input.initialDelayMs, 20_000, 1_000),
        researchIntervalMs: whole(input.researchIntervalMs, 300_000, 60_000),
        sources,
        readOnlyTools,
        executionTools,
        reviewModel: text(input.reviewModel),
        reviewProvider: text(input.reviewProvider),
        reviewTimeoutMs: whole(input.reviewTimeoutMs, 20_000, 1_000, 120_000),
        rules,
        autoApproveLowRisk: input.autoApproveLowRisk ?? false,
        dotWorkspace: text(input.dotWorkspace),
        maxProposalsPerRound: whole(input.maxProposalsPerRound, 3, 1, 10),
        researchPrompt: text(input.researchPrompt),
        agentPreset: text(input.agentPreset) || 'standard',
        workerTimeoutMs: whole(input.workerTimeoutMs, 900_000, 10_000),
        workerMaxTurns: whole(input.workerMaxTurns, 3, 1, 10),
        workerStageMaxBytes: whole(input.workerStageMaxBytes, 1_048_576, 1_024, 10_485_760),
        maxWorkers: whole(input.maxWorkers, 4, 2, 8),
        stateDir: text(input.stateDir),
    };
}
function normalizeSources(input) {
    if (!Array.isArray(input))
        return [];
    const sources = [];
    for (const source of input) {
        if (!source || typeof source !== 'object')
            continue;
        const id = text(source.id);
        const label = text(source.label) || id;
        const kind = source.kind;
        if (!id || !label || (kind !== 'directory' && kind !== 'url' && kind !== 'mcp'))
            continue;
        if (kind === 'directory' && !text(source.path))
            continue;
        if (kind === 'url' && !text(source.url))
            continue;
        sources.push({
            id,
            kind,
            label,
            path: kind === 'directory' ? path.resolve(expandHome(text(source.path))) : undefined,
            url: kind === 'url' ? text(source.url) : undefined,
            tools: Array.isArray(source.tools)
                ? source.tools.filter((tool) => typeof tool === 'string' && tool.trim() !== '')
                : [],
            enabled: source.enabled !== false,
        });
    }
    return sources;
}
function normalizeToolNames(input, fallback) {
    const values = Array.isArray(input) ? input : fallback;
    const names = values
        .filter((value) => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean);
    return [...new Set(names)];
}
function normalizeRules(input) {
    if (!Array.isArray(input))
        return DEFAULT_RULES.map((rule) => ({ ...rule }));
    const rules = [];
    for (const rule of input) {
        if (!rule || typeof rule !== 'object')
            continue;
        const pattern = text(rule.action_pattern);
        const decision = rule.decision === 'allow' || rule.decision === 'ask' || rule.decision === 'deny'
            ? rule.decision
            : undefined;
        if (pattern && decision)
            rules.push({ action_pattern: pattern, decision });
    }
    return rules.length > 0 ? rules : DEFAULT_RULES.map((rule) => ({ ...rule }));
}
function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}
function whole(value, fallback, min, max) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return fallback;
    const whole = Math.trunc(value);
    if (whole < min)
        return min;
    if (max !== undefined && whole > max)
        return max;
    return whole;
}
function expandHome(value) {
    if (value === '~')
        return process.env.HOME || value;
    if (value.startsWith('~/'))
        return path.join(process.env.HOME || '~', value.slice(2));
    return value;
}
