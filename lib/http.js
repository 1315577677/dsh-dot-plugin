const PREFIX = '/dsh-dot';
const ROUTE_PREFIX = '/dsh-dot/';
const MAX_BODY = 64 * 1024 * 1024;
/**
 * Local Web bridge used by the Dot panel and for tests.
 *
 * There is no package-private Host RPC for ordinary bundles, so the Client
 * panel uses this same-origin route. POST requires a custom header (forcing a
 * CORS preflight that this route never approves) and any Origin must match the
 * serving Web origin. Approval is still user-only: no Agent Tool can call it.
 */
export function startHttpBridge(ctx, runtime, log) {
    return ctx.effect(() => ctx.webServer.register({
        kind: 'prefix',
        path: PREFIX,
        handler: async (req, res) => {
            try {
                await handle(ctx, runtime, req, res);
            }
            catch (error) {
                log('dsh-dot: HTTP bridge error', error);
                send(res, 500, { ok: false, error: 'internal_error' });
            }
        },
    }), 'dsh-dot: Web bridge');
}
async function handle(ctx, runtime, req, res) {
    const origin = req.headers?.origin;
    if (typeof origin === 'string' && origin && origin !== ctx.webServer.getOrigin()) {
        send(res, 403, { ok: false, error: 'origin_rejected' });
        return;
    }
    const url = new URL(String(req.url ?? ROUTE_PREFIX), 'http://127.0.0.1');
    if (!url.pathname.startsWith(ROUTE_PREFIX) && url.pathname !== PREFIX) {
        send(res, 404, { ok: false, error: 'not_found' });
        return;
    }
    if (req.method === 'GET' && url.pathname === `${ROUTE_PREFIX}health`) {
        send(res, 200, { ok: true, name: 'dsh-dot', version: 2 });
        return;
    }
    if (req.method === 'GET' && url.pathname === `${ROUTE_PREFIX}state`) {
        send(res, 200, await runtime.getClientState());
        return;
    }
    if (req.method === 'GET' && url.pathname === `${ROUTE_PREFIX}config`) {
        send(res, 200, { ok: true, systemProactive: runtime.getSystemProactiveConfig() });
        return;
    }
    // Small push-surrogate for the always-mounted Client notifier. It never
    // carries the full task/worker/chat history, so polling it from the shell is
    // cheap even when the Dot panel is closed.
    if (req.method === 'GET' && url.pathname === `${ROUTE_PREFIX}notifications`) {
        const state = await runtime.getClientState();
        const assistant = (state.chatMessages ?? [])
            .filter((message) => message.role === 'assistant')
            .slice(-6)
            .map((message) => ({
            id: message.id,
            text: message.text,
            at: message.at,
            seq: message.seq,
        }));
        const approvals = (state.approvals ?? [])
            .filter((approval) => approval.status === 'pending')
            .map((approval) => ({
            id: approval.id,
            taskTitle: approval.taskTitle,
            createdAt: approval.createdAt,
        }));
        const proposals = (state.proposals ?? [])
            .filter((proposal) => proposal.status === 'pending')
            .map((proposal) => ({ id: proposal.id, title: proposal.title, createdAt: proposal.createdAt }));
        send(res, 200, {
            ok: true,
            assistant,
            approvals,
            proposals,
            dotStatus: state.dotStatus,
        });
        return;
    }
    if (req.method === 'GET' && url.pathname.startsWith(`${ROUTE_PREFIX}attachment/`)) {
        const attachmentId = decodeURIComponent(url.pathname.slice(`${ROUTE_PREFIX}attachment/`.length));
        if (!attachmentId || attachmentId.includes('/')) {
            send(res, 404, { ok: false, error: 'not_found' });
            return;
        }
        const image = await runtime.readChatImage(attachmentId);
        if (!image) {
            send(res, 404, { ok: false, error: 'not_found' });
            return;
        }
        res.writeHead(200, {
            'content-type': image.mediaType,
            'content-length': String(image.data.length),
            'cache-control': 'private, max-age=3600',
            'x-content-type-options': 'nosniff',
        });
        res.end(image.data);
        return;
    }
    if (req.method !== 'POST') {
        send(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
    }
    if (req.headers?.['x-dsh-dot'] !== '1') {
        send(res, 403, { ok: false, error: 'missing_bridge_header' });
        return;
    }
    const body = await readJson(req).catch(() => undefined);
    if (body === undefined) {
        send(res, 400, { ok: false, error: 'invalid_json' });
        return;
    }
    if (url.pathname === `${ROUTE_PREFIX}config`) {
        const patch = body?.systemProactive && typeof body.systemProactive === 'object'
            ? body.systemProactive
            : body;
        try {
            const systemProactive = await runtime.updateSystemProactiveConfig(patch);
            send(res, 200, { ok: true, systemProactive });
        }
        catch (error) {
            send(res, 409, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
        return;
    }
    if (url.pathname === `${ROUTE_PREFIX}check`) {
        const reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'manual';
        const result = await runtime.runResearch(reason);
        send(res, result.started ? 200 : 409, {
            ok: result.started,
            ...result,
            state: await runtime.getClientState(),
        });
        return;
    }
    if (url.pathname === `${ROUTE_PREFIX}chat`) {
        const text = typeof body?.text === 'string' ? body.text : '';
        const images = Array.isArray(body?.images)
            ? body.images
                .filter((image) => image &&
                typeof image === 'object' &&
                typeof image.data === 'string' &&
                typeof image.mediaType === 'string' &&
                /^image\/(png|jpeg|webp|gif)$/.test(image.mediaType))
                .slice(0, 4)
                .map((image) => ({
                data: image.data,
                mediaType: image.mediaType,
                ...(typeof image.name === 'string' ? { name: image.name.slice(0, 200) } : {}),
            }))
            : [];
        if (!text.trim() && images.length === 0) {
            send(res, 400, { ok: false, error: 'text or image is required' });
            return;
        }
        try {
            const result = await runtime.sendUserChat(text, images);
            send(res, 200, { ...result, state: await runtime.getClientState() });
        }
        catch (error) {
            send(res, 409, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
        return;
    }
    if (url.pathname === `${ROUTE_PREFIX}approval/review`) {
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
        const toolName = typeof body?.toolName === 'string' ? body.toolName : 'unknown';
        const reason = typeof body?.reason === 'string' ? body.reason : '';
        if (!sessionId) {
            send(res, 400, { ok: false, error: 'sessionId is required' });
            return;
        }
        try {
            const result = await runtime.reviewWorkerApprovalRequest(sessionId, toolName, reason);
            send(res, 200, { ok: true, ...result });
        }
        catch (error) {
            send(res, 409, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
        return;
    }
    if (url.pathname === `${ROUTE_PREFIX}approval`) {
        const approvalId = typeof body?.approvalId === 'string' ? body.approvalId : '';
        const decision = body?.decision === 'allow' ? 'allow' : body?.decision === 'reject' ? 'reject' : undefined;
        if (!approvalId || !decision) {
            send(res, 400, { ok: false, error: 'approvalId and decision are required' });
            return;
        }
        try {
            const approval = await runtime.decideApproval(approvalId, decision, typeof body?.reason === 'string' ? body.reason : undefined);
            send(res, 200, { ok: true, approval, state: await runtime.getClientState() });
        }
        catch (error) {
            send(res, 409, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
        return;
    }
    if (url.pathname === `${ROUTE_PREFIX}focus`) {
        const taskId = typeof body?.taskId === 'string' ? body.taskId : '';
        if (!taskId) {
            send(res, 400, { ok: false, error: 'taskId is required' });
            return;
        }
        try {
            const task = await runtime.focusTask(taskId);
            send(res, 200, { ok: true, task, state: await runtime.getClientState() });
        }
        catch (error) {
            send(res, 409, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
        return;
    }
    if (url.pathname === `${ROUTE_PREFIX}decision`) {
        const proposalId = typeof body?.proposalId === 'string' ? body.proposalId : '';
        const decision = body?.decision === 'approve' ? 'approve' : body?.decision === 'reject' ? 'reject' : undefined;
        if (!proposalId || !decision) {
            send(res, 400, { ok: false, error: 'proposalId and decision are required' });
            return;
        }
        const note = typeof body?.note === 'string' ? body.note.slice(0, 1000) : undefined;
        const result = decision === 'approve'
            ? await runtime.approveProposal(proposalId)
            : await runtime.rejectProposal(proposalId, note);
        send(res, result.ok ? 200 : 409, {
            ...result,
            state: await runtime.getClientState(),
        });
        return;
    }
    if (url.pathname === `${ROUTE_PREFIX}trigger`) {
        const triggerId = typeof body?.triggerId === 'string' ? body.triggerId : '';
        if (!triggerId) {
            send(res, 400, { ok: false, error: 'triggerId is required' });
            return;
        }
        const result = await runtime.fireTrigger(triggerId, body?.payload ?? null);
        send(res, 200, { ...result, state: await runtime.getClientState() });
        return;
    }
    send(res, 404, { ok: false, error: 'not_found' });
}
async function readJson(req) {
    let size = 0;
    let raw = '';
    for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > MAX_BODY)
            return undefined;
        raw += String(chunk);
    }
    if (!raw.trim())
        return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
}
function send(res, status, body) {
    if (res.writableEnded)
        return;
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
    });
    res.end(JSON.stringify(body));
}
