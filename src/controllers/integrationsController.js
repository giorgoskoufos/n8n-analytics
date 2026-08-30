/**
 * Connecting the documentation service from the app.
 *
 * The whole flow, so nobody has to edit an environment file: press Connect, the
 * browser goes to the service, you approve, it comes back, the tool works.
 *
 * ── Two things this file has to get right ────────────────────────────────
 *
 * **The credential is per person.** The service issues it against the
 * approver's own account, so a shared one attributes everybody's questions to
 * whoever set it up — and lands any abuse on them. Every route here is scoped
 * to `req.user.id`, and dao/integrationsDao deliberately has no fallback to a
 * shared credential.
 *
 * **The pending flow is bound to a session.** `state` is not merely random; it
 * is stored against the user who started the flow and checked against the user
 * who returns. Without that binding the classic attack works: an attacker
 * completes an authorisation with their own account, gets you to open the
 * resulting callback, and your user ends up holding a credential for their
 * identity — every question you ask then runs under their account.
 */

const oauth = require('../ai/oauth');
const integrations = require('../dao/integrationsDao');
const docs = require('../ai/tools/docs');
const log = require('../utils/logger').logger('INTEGRATIONS');

/**
 * Flows waiting for the browser to come back.
 *
 * In memory, not in the replica. The PKCE verifier is a secret with a lifetime
 * measured in a couple of minutes, and writing it to a database that is already
 * carrying production data buys nothing — this application runs as a single
 * process (the instance lock in config/instanceLock), so there is no second
 * process that would need to read it.
 */
const pending = new Map();
const PENDING_TTL_MS = 10 * 60 * 1000;

function sweepPending() {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [state, flow] of pending) {
        if (flow.startedAt < cutoff) pending.delete(state);
    }
}

/**
 * Where the service should send the browser back to.
 *
 * Derived from the request rather than configured, so a deployment behind a
 * proxy or on a different host does not need a second setting that can disagree
 * with reality. `x-forwarded-*` is honoured because the redirect has to be the
 * public address, not the container's.
 */
function callbackUrl(req) {
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    return `${proto}://${host}/api/integrations/docs/callback`;
}

/** What the settings page renders. Never a token. */
exports.status = async (req, res) => {
    try {
        res.json(await integrations.describe(docs.PROVIDER, req.user.id));
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Could not read the integration status' });
    }
};

/**
 * Starts the flow and returns the URL for the browser to visit.
 *
 * The URL is returned rather than redirected to, because this is called by
 * fetch from a page that has an Authorization header to send. A 302 from an XHR
 * would be followed by fetch and land the authorisation page inside a response
 * the page cannot use.
 */
exports.connect = async (req, res) => {
    try {
        sweepPending();
        const redirectUri = callbackUrl(req);
        const { meta, resource } = await oauth.discover(docs.ENDPOINT);

        // Registered per flow rather than once. Dynamic registration is cheap,
        // and a client id stored somewhere would be one more thing to keep in
        // step with a redirect URI that is derived from the request.
        const client = await oauth.register(meta, {
            redirectUri,
            clientName: 'n8n Analytics Dashboard'
        });

        const { url, verifier, state } = oauth.authorizeUrl(meta, {
            clientId: client.client_id,
            redirectUri,
            resource
        });

        pending.set(state, {
            userId: req.user.id,
            clientId: client.client_id,
            verifier,
            redirectUri,
            resource,
            startedAt: Date.now()
        });

        res.json({ url });
    } catch (err) {
        log.error('Could not start the docs connection:', err);
        res.status(502).json({ error: `Could not reach the documentation service: ${err.message}` });
    }
};

/**
 * Where the browser lands after approving.
 *
 * Answers HTML rather than JSON: this is a top-level navigation the person is
 * looking at, not an API call. It closes itself if it was opened as a popup and
 * otherwise offers the way back.
 */
exports.callback = async (req, res) => {
    const { code, state, error } = req.query;

    const flow = state ? pending.get(state) : null;
    if (state) pending.delete(state);

    const finish = (title, message, ok) => {
        res.status(ok ? 200 : 400).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui;background:#171717;color:#eee;padding:3rem;max-width:34rem">
  <h2 style="color:${ok ? '#4ade80' : '#f87171'}">${title}</h2>
  <p style="color:#b9b7b0">${message}</p>
  <p><a href="/pages/settings.html" style="color:#ff6f5c">Back to settings</a></p>
  <script>if (window.opener) { window.opener.postMessage('docs-connected', '*'); setTimeout(() => window.close(), 1200); }</script>
</body></html>`);
    };

    if (error) return finish('Not connected', `The service reported: ${error}`, false);

    // An unknown state is either an expired flow or one this browser did not
    // start. Both get the same answer; distinguishing them would tell an
    // attacker which of their guesses was close.
    if (!flow) {
        return finish('Not connected',
            'That authorisation link has expired or did not come from here. Try again from settings.',
            false);
    }
    if (!code) return finish('Not connected', 'No authorisation code came back.', false);

    try {
        const { meta } = await oauth.discover(docs.ENDPOINT);
        const tokens = await oauth.exchange(meta, {
            code,
            clientId: flow.clientId,
            redirectUri: flow.redirectUri,
            verifier: flow.verifier,
            resource: flow.resource
        });

        if (!tokens.refresh_token) {
            // Without one the connection dies in an hour and the person has to
            // come back — better to say so now than to look connected and stop.
            return finish('Not connected',
                'The service did not issue a refresh token, so the connection could not be kept. ' +
                'Nothing was saved.', false);
        }

        await integrations.save(docs.PROVIDER, {
            clientId: flow.clientId,
            refreshToken: tokens.refresh_token,
            accessToken: tokens.access_token,
            expiresInMs: (Number(tokens.expires_in) || 3600) * 1000,
            connectedBy: flow.userId,
            owner: flow.userId
        });
        docs.invalidate(flow.userId);
        log.info(`Docs service connected for ${flow.userId}.`);

        finish('Connected',
            'The assistant can now answer from the n8n documentation. You can close this tab.', true);
    } catch (err) {
        log.error('Docs token exchange failed:', err);
        finish('Not connected', `The exchange failed: ${err.message}`, false);
    }
};

exports.disconnect = async (req, res) => {
    try {
        await integrations.disconnect(docs.PROVIDER, req.user.id);
        docs.invalidate(req.user.id);
        res.json({ message: 'Disconnected' });
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Could not disconnect' });
    }
};

// ==========================================================================
// The assistant's own credentials
// ==========================================================================

/**
 * The OpenAI key and the model, as a settings field rather than a restart.
 *
 * ── Why this is here and not in metricsController with the other settings ──
 *
 * Because of what `GET /api/settings` is. That endpoint returns every row of
 * `dashboard_settings` to any authenticated page, which is exactly right for a
 * timezone and exactly wrong for a bearer credential against somebody's billing
 * account. Putting the key in that table would have leaked it into a response
 * nobody would think to audit — so it lives in `dashboard_secrets` (migration
 * 024) with the same two-reader rule the OAuth credentials above follow, and
 * these handlers are the only HTTP surface it has.
 *
 * The MODEL is not a secret and does stay in `dashboard_settings`, saved through
 * the ordinary settings endpoint and validated by the ordinary allowlist. Only
 * the key needs this file.
 */

const aiConfig = require('../dao/aiConfigDao');
const { validateApiKey } = require('../utils/validate');

/**
 * What Settings may render: configured or not, the last four characters, and
 * which of Settings and the environment is actually in force.
 *
 * Readable by any authenticated user, unlike the writes below. Whether the
 * assistant is configured is not a secret — it is the answer to "why is the chat
 * refusing to talk to me", and a member who cannot see it has no way to know
 * whether to raise it with an admin or with support.
 */
exports.aiStatus = async (req, res) => {
    try {
        res.json(await aiConfig.describe());
    } catch (err) {
        log.error('Assistant config read error:', err);
        res.status(500).json({ error: 'Could not read the assistant configuration.' });
    }
};

/**
 * Stores a key.
 *
 * The key never comes back out of this endpoint, and it is not echoed into the
 * response: the reply is the same `describe()` every other caller gets, with the
 * last four characters, so the page can confirm the right key landed without the
 * value making a second trip over the wire.
 *
 * Not verified against the provider here. A save that has to wait on a network
 * round trip is a save that fails when the provider is briefly down, and the
 * verification a person actually trusts is the next answer working.
 */
exports.saveAiKey = async (req, res) => {
    try {
        const check = validateApiKey(req.body?.apiKey);
        if (!check.ok) return res.status(400).json({ error: check.error });

        await aiConfig.setApiKey(check.value, req.user.id);
        log.info(`Assistant API key set by ${req.user.id}.`);
        res.json(await aiConfig.describe());
    } catch (err) {
        log.error('Assistant key save error:', err);
        res.status(500).json({ error: 'Could not save the API key.' });
    }
};

/**
 * Removes the stored key.
 *
 * Which is not the same as turning the assistant off: a deployment that still
 * has `OPENAI_API_KEY` in its environment falls back to it, and the response
 * says so rather than leaving the page to claim a disconnection that did not
 * happen. See the note on aiConfigDao.clearApiKey for why the fallback survives.
 */
exports.clearAiKey = async (req, res) => {
    try {
        await aiConfig.clearApiKey();
        log.info(`Assistant API key cleared by ${req.user.id}.`);
        res.json(await aiConfig.describe());
    } catch (err) {
        log.error('Assistant key clear error:', err);
        res.status(500).json({ error: 'Could not remove the API key.' });
    }
};
