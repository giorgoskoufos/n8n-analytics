/**
 * The n8n documentation, over MCP.
 *
 * A different kind of knowledge from everything else here. The DAOs answer what
 * happened on this instance; this answers how n8n is supposed to work. The
 * combination is the point: `Invalid URL` occurs 3,976 times on this replica —
 * our data says where and how often, the documentation says what causes it.
 *
 * ── Why there is nothing to paste into an environment file ───────────────
 *
 * The service answers 401 and advertises OAuth. Asked what it accepts:
 *
 *     grant_types_supported: ["authorization_code", "refresh_token"]
 *
 * and nothing else. There is no `client_credentials`, so a server cannot
 * authenticate as itself, and there is no field anywhere to copy a token from.
 * Somebody approves it in a browser once — from Settings, or from
 * `src/scripts/connectDocsMcp.js` on a box with no browser — and the credential
 * is stored in the replica by dao/integrationsDao.
 *
 * `refresh_token` is what makes it usable from a server afterwards: this file
 * spends the stored refresh token for short-lived access tokens and writes back
 * any rotation, so nobody is asked again.
 *
 * Until it is connected the tool is not registered at all. A tool the model can
 * see but cannot use is worse than an absent one: it gets chosen, it fails, and
 * the failure reads to the user as the assistant being broken rather than as a
 * feature that was never switched on.
 */

const integrations = require('../../dao/integrationsDao');
const oauth = require('../oauth');
const log = require('../../utils/logger').logger('AI-DOCS');

const PROVIDER = 'n8n-docs';
const ENDPOINT = process.env.N8N_DOCS_MCP_URL || 'https://n8n.mcp.kapa.ai';
const TIMEOUT_MS = Number(process.env.N8N_DOCS_TIMEOUT_MS) || 20_000;

// Per user. An MCP session is established against a particular token, so
// reusing one across people would send one person's questions under another's
// session. The chosen tool is safe to share: it is a property of the remote
// identical for everyone.
const sessions = new Map();
let tool = null;   // { name, inputSchema }
let discovered = null;
// One refresh in flight per user, so simultaneous questions from the same
// person do not each spend the refresh token — with a rotating server, two of
// three would be spending one the third had just invalidated.
const refreshing = new Map();

/**
 * Whether the tool should be offered — to THIS user.
 *
 * Per user, not per deployment. The credential is bound to the approver's
 * personal account at the docs service, so one shared connection would attribute
 * everybody's questions to one person and land any abuse on them. See the note
 * in dao/integrationsDao.
 *
 * Cached per user, because this is asked on every chat turn to decide the tool
 * list and the answer only changes when someone connects or disconnects. The TTL
 * is short so a fresh connection lights the tool up without a restart, which was
 * the point of moving this out of the environment.
 */
const connected = new Map();
const CONNECTED_TTL_MS = 30_000;

async function refreshConnectedFlag(userId) {
    const row = await integrations.find(PROVIDER, userId);
    const value = Boolean(row && row.refresh_token);
    connected.set(userId, { value, at: Date.now() });
    return value;
}

/**
 * Synchronous, because the tool registry is built synchronously.
 *
 * Reports the last known answer and refreshes in the background when it is
 * stale. The cost of being wrong is bounded and asymmetric: a stale `false`
 * means the tool is missing for up to thirty seconds after connecting, while a
 * stale `true` means one call fails with a message that says what to do.
 * Neither is worth making every chat turn wait on a query.
 */
function isConfigured(userId) {
    if (!userId) return false;
    const seen = connected.get(userId);
    if (!seen || Date.now() - seen.at > CONNECTED_TTL_MS) {
        refreshConnectedFlag(userId)
            .catch((err) => log.warn(`Could not read the docs credential: ${err.message}`));
    }
    return Boolean(seen && seen.value);
}

/** Called after connect/disconnect so the tool list reacts immediately. */
function invalidate(userId) {
    connected.delete(userId);
    // The session belonged to the credential that has just gone.
    sessions.delete(userId);
}

async function meta() {
    if (!discovered) discovered = await oauth.discover(ENDPOINT);
    return discovered.meta;
}

/**
 * A valid access token, minted from the stored refresh token when necessary.
 *
 * Renewed 60 seconds before expiry rather than after a failure, so a question is
 * not paid for twice to discover the token went stale mid-flight. Concurrent
 * callers share one refresh: without the promise guard, three simultaneous
 * questions would send three refreshes, and with a rotating server two of them
 * would be spending a token the third had just invalidated.
 */
async function accessToken(userId) {
    const cred = await integrations.secretFor(PROVIDER, userId);
    if (!cred || !cred.refreshToken) {
        throw new Error('You have not connected the n8n documentation service yet. ' +
            'Connect it from Settings.');
    }
    if (cred.accessToken && Date.now() < cred.accessExpiresAt - 60_000) {
        return cred.accessToken;
    }
    const inFlight = refreshing.get(userId);
    if (inFlight) return inFlight;

    const task = (async () => {
        let tokens;
        try {
            tokens = await oauth.refresh(await meta(), {
                refreshToken: cred.refreshToken,
                clientId: cred.clientId
            });
        } catch (err) {
            throw new Error('The documentation connection has expired. ' +
                `Reconnect it from Settings. (${err.message})`);
        }
        await integrations.updateTokens(PROVIDER, cred.owner, {
            accessToken: tokens.access_token,
            expiresInMs: (Number(tokens.expires_in) || 3600) * 1000,
            // Written back, not discarded. A server that rotates on use
            // invalidates the old one, and a client that keeps it works today
            // and stops days later pointing at the wrong cause.
            refreshToken: tokens.refresh_token
        });
        log.info('Docs token refreshed.');
        return tokens.access_token;
    })().finally(() => { refreshing.delete(userId); });

    refreshing.set(userId, task);
    return task;
}

/**
 * One JSON-RPC call over streamable HTTP.
 *
 * The transport may answer with a JSON body or an SSE stream and chooses for
 * itself, so both are advertised in Accept and an SSE reply is parsed for its
 * `data:` lines rather than assumed to be JSON.
 */
async function rpc(method, params, userId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const headers = {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            Authorization: `Bearer ${await accessToken(userId)}`
        };
        const known = sessions.get(userId);
        if (known) headers['Mcp-Session-Id'] = known;

        const res = await fetch(ENDPOINT, {
            method: 'POST',
            headers,
            signal: controller.signal,
            body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
        });

        const sid = res.headers.get('mcp-session-id');
        if (sid) sessions.set(userId, sid);

        const text = await res.text();
        if (!res.ok) throw new Error(`MCP ${res.status}: ${text.slice(0, 200)}`);

        const body = (res.headers.get('content-type') || '').includes('text/event-stream')
            ? text.split('\n')
                .filter((l) => l.startsWith('data:'))
                .map((l) => l.slice(5).trim())
                .filter(Boolean)
                .join('')
            : text;

        const parsed = JSON.parse(body);
        if (parsed.error) throw new Error(parsed.error.message || 'MCP error');
        return parsed.result;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Handshakes once and learns what the server actually calls its search tool.
 *
 * Discovered rather than hard-coded: this is somebody else's server, and a name
 * pinned here would break silently on the day they rename it — the tool would go
 * on being offered and start returning nothing.
 */
async function connect(userId) {
    // Two separate caches, because they have different lifetimes. The tool is
    // a fact about the remote server and is the same for everyone; the session
    // is per credential. Returning early on the tool alone would let the
    // second user skip `initialize` and call a tool with no session of their
    // own — which fails, or worse, is answered under somebody else's.
    if (tool && sessions.has(userId)) return tool;

    await rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'n8n-analytics', version: '1.0' }
    }, userId);

    if (tool) return tool;

    const listed = await rpc('tools/list', {}, userId);
    const tools = (listed && listed.tools) || [];
    if (tools.length === 0) throw new Error('The docs server offers no tools.');

    // A read-only search tool, and never anything else.
    //
    // This server also offers `give_feedback`, which posts a message to the n8n
    // team. That is an outward-facing write on somebody else's service, sent
    // under this user's credential, and not something an assistant should be
    // able to reach for on its own — so the choice is an allowlist of shapes
    // rather than "whatever looks likely, else the first one". A first-match
    // fallback would have picked it the day the server reordered its list.
    const candidate = tools.find((t) => /search|retriev|ask|query|docs?/i.test(t.name)
        && !/feedback|report|submit|create|write|send/i.test(t.name));
    if (!candidate) {
        throw new Error('The docs server offers no read-only search tool.');
    }

    tool = { name: candidate.name, inputSchema: candidate.inputSchema || {} };
    log.info(`Docs MCP connected — using "${tool.name}".`);
    return tool;
}

/**
 * Builds the arguments this particular tool declares it wants.
 *
 * Read from the schema rather than assumed. The first attempt sent both `query`
 * and `question` to cover either spelling, and the server rejected the call
 * outright: its schema is `additionalProperties: false`, so the extra key was
 * not ignored, it was an error — and the rejection arrived as an opaque "Error
 * calling tool", naming nothing.
 */
function argumentsFor(schema, question) {
    const props = (schema && schema.properties) || {};
    const required = (schema && schema.required) || [];

    const target = required.find((k) => (props[k] || {}).type === 'string')
        || Object.keys(props).find((k) => props[k].type === 'string');
    return target ? { [target]: question } : { query: question };
}

/** Asks the documentation one question. Returns text. */
async function ask(question, userId) {
    const chosen = await connect(userId);
    const result = await rpc('tools/call', {
        name: chosen.name,
        arguments: argumentsFor(chosen.inputSchema, question)
    }, userId);

    const parts = ((result && result.content) || [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text);
    return parts.join('\n\n').slice(0, 8000) || 'The documentation returned nothing for that.';
}

module.exports = {
    ask, isConfigured, invalidate, PROVIDER, ENDPOINT,
    _internal: { rpc, connect, accessToken, refreshConnectedFlag, argumentsFor }
};
