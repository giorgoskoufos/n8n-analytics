#!/usr/bin/env node
/**
 * Connects the n8n documentation service from a terminal.
 *
 *     node src/scripts/connectDocsMcp.js <user-email-or-id>
 *
 * The same thing Settings > Integrations does, for a deployment where opening
 * the dashboard in a browser is awkward — a server you only reach over SSH, or
 * a first run before anyone has logged in.
 *
 * ── Why a user has to be named ───────────────────────────────────────────
 *
 * The credential is issued by the documentation service against the account
 * that approves it, and it is stored per person for that reason: a shared one
 * would attribute everybody's questions to whoever set it up, and land any
 * misuse of the service on them. So this script has to be told whose connection
 * it is making, and the browser step must be done by that person.
 *
 * The OAuth itself is `src/ai/oauth.js`, shared with the controller. Two
 * implementations of one protocol is how "it works from the terminal but not
 * from the UI" happens, and that is a day to diagnose.
 */

const http = require('http');
const { spawn } = require('child_process');

require('dotenv').config();
const localDb = require('../config/localDb');
const oauth = require('../ai/oauth');
const integrations = require('../dao/integrationsDao');

const RESOURCE = process.env.N8N_DOCS_MCP_URL || 'https://n8n.mcp.kapa.ai';
const PORT = Number(process.env.DOCS_OAUTH_PORT) || 8765;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;

/** Waits for the browser to come back with a code. */
function awaitRedirect(expectedState) {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
            if (url.pathname !== '/callback') {
                res.writeHead(404).end();
                return;
            }
            const code = url.searchParams.get('code');
            const state = url.searchParams.get('state');
            const error = url.searchParams.get('error');

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<!doctype html><meta charset="utf-8">
                <body style="font-family:system-ui;padding:3rem;background:#171717;color:#eee">
                <h2>${error ? 'Authorisation failed' : 'Connected'}</h2>
                <p>${error || 'You can close this tab and return to the terminal.'}</p>
                </body>`);
            server.close();

            if (error) return reject(new Error(error));
            // The state check is what stops a link somebody else crafted from
            // completing this flow.
            if (state !== expectedState) return reject(new Error('state mismatch — aborting'));
            resolve(code);
        });
        server.on('error', reject);
        server.listen(PORT, '127.0.0.1');
        setTimeout(() => {
            server.close();
            reject(new Error('Timed out waiting for the browser (5 minutes).'));
        }, 300_000);
    });
}

function openBrowser(url) {
    // Not through `cmd /c start`: cmd treats `&` as a command separator, so a
    // URL with query parameters arrives truncated at the first one — which the
    // authorization server then rejects for a missing client_id, naming a
    // parameter that was in fact sent.
    const [cmd, args] = process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    try {
        spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
    } catch (ignored) {
        // Printed either way; a browser that will not open is not a failure.
    }
}

/** Resolves an email or id to a user this dashboard knows. */
async function resolveUser(needle) {
    const r = await localDb.query(
        'SELECT id, email FROM users WHERE id = ? OR LOWER(email) = LOWER(?)',
        [needle, needle]
    );
    if (r.rows.length === 0) {
        throw new Error(`No user matches "${needle}". They have to sign in to the ` +
            'dashboard once before a connection can be attached to them.');
    }
    return r.rows[0];
}

async function main() {
    const needle = process.argv[2];
    if (!needle) {
        console.error('\n  Usage: node src/scripts/connectDocsMcp.js <user-email-or-id>\n');
        console.error('  The connection is personal, so it has to be attached to somebody.\n');
        process.exit(1);
    }

    await localDb.ready;
    const user = await resolveUser(needle);
    console.log(`\nConnecting ${RESOURCE}`);
    console.log(`  for                  : ${user.email || user.id}`);

    const { meta, resource } = await oauth.discover(RESOURCE);
    console.log(`  authorization server : ${meta.issuer}`);

    const client = await oauth.register(meta, {
        redirectUri: REDIRECT,
        clientName: 'n8n Analytics Dashboard (CLI)'
    });
    console.log(`  client registered    : ${client.client_id}`);

    const { url, verifier, state } = oauth.authorizeUrl(meta, {
        clientId: client.client_id,
        redirectUri: REDIRECT,
        resource
    });

    console.log('\n  Opening a browser to approve access.');
    console.log('  If it does not open, copy this WHOLE line:\n');
    console.log(`    ${url}\n`);
    openBrowser(url);

    const code = await awaitRedirect(state);
    console.log('  authorisation code   : received');

    const tokens = await oauth.exchange(meta, {
        code, clientId: client.client_id, redirectUri: REDIRECT, verifier, resource
    });

    if (!tokens.refresh_token) {
        throw new Error('The service issued no refresh token, so the connection could not be ' +
            'kept alive. Nothing was saved.');
    }

    await integrations.save('n8n-docs', {
        clientId: client.client_id,
        refreshToken: tokens.refresh_token,
        accessToken: tokens.access_token,
        expiresInMs: (Number(tokens.expires_in) || 3600) * 1000,
        connectedBy: user.id,
        owner: user.id
    });

    console.log('\n  Saved. The assistant can now answer from the n8n documentation');
    console.log(`  for ${user.email || user.id}. Nothing needs to go into the environment,`);
    console.log('  and nothing needs restarting.\n');
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error(`\n  Failed: ${err.message}\n`);
        process.exit(1);
    });
