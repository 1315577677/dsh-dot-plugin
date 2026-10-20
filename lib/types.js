/**
 * Shared types for DSH Dot.
 *
 * The Dot is a real persistent Agent with its own Session. Its research phase
 * is read-only; proposals are durable records reviewed by the user; approved
 * execution is a separate scoped Agent turn with a tool allowlist.
 *
 * State v2 introduces the task-orchestrator model. The legacy v1 task shape is
 * migrated by state.ts and is not used by runtime code.
 */
export const DEFAULT_RULES = [
    {
        action_pattern: '(^|_)(send|email|invoice|publish|share|pay|purchase|transfer|delete|remove|invite)',
        decision: 'ask',
    },
    {
        action_pattern: '^(read|analyze|draft|prepare|summari[sz]e|investigate)',
        decision: 'allow',
    },
];
export const DEFAULT_READ_ONLY_TOOLS = ['read', 'glob', 'grep', 'web_search', 'web_fetch'];
export const DEFAULT_EXECUTION_TOOLS = ['write', 'edit'];
export function emptyState() {
    return {
        version: 2,
        proposals: [],
        tasks: [],
        workers: [],
        triggers: [],
        pendingAuto: [],
    };
}
