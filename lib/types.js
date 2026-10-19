/**
 * Shared types for the DSH-native DSH Dot.
 *
 * The Dot is a real persistent Agent with its own Session. Its research phase
 * is read-only; proposals are durable records reviewed by the user; approved
 * execution is a separate scoped Agent turn with a tool allowlist.
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
        version: 1,
        proposals: [],
        tasks: [],
        triggers: [],
        pendingAuto: [],
    };
}
