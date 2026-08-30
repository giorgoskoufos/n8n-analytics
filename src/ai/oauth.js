/**
 * The OAuth handshake the documentation service requires.
 *
 * One implementation, two front ends. The CLI script exists for a headless
 * deployment with no browser on the box; the settings page exists because
 * editing an environment file is a poor way to connect something. They must not
 * be two implementations of a protocol — a divergence between them would show up
 * as "it works from the terminal but not from the UI", which is a day to
 * diagnose.
 *
 * Nothing here reads or writes storage. Where the resulting tokens go is the
 * caller's business: the script prints them, the controller saves them.
 */

const crypto = require('crypto');

const b64url = (buf) => buf.toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function json(url, opts) {
    const res = await fetch(url, opts);
    const text = await res.text();
    if (!res.ok) throw new Error(`${url} -> ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
}

/**
 * Finds the authorization server the way the MCP spec says to.
 *
 * The resource advertises its issuer; the issuer advertises its endpoints.
 * Discovered rather than hard-coded, so this keeps working if the service moves
 * — pinned endpoints produce a failure one day with a 404 and no clue what
 * changed.
 *
 * RFC 8414 inserts `.well-known` between the host and the path, which is not
 * where OpenID Connect puts it. Both spellings are tried because both exist.
 */
async function discover(resourceUrl) {
    const pr = await json(`${resourceUrl}/.well-known/oauth-protected-resource`);
    const issuer = pr.authorization_servers[0];
    const url = new URL(issuer);

    const candidates = [
        `${url.origin}/.well-known/oauth-authorization-server${url.pathname}`,
        `${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`,
        `${url.origin}/.well-known/openid-configuration${url.pathname}`
    ];
    for (const candidate of candidates) {
        try {
            return { meta: await json(candidate), resource: pr.resource };
        } catch (ignored) {
            // Next spelling.
        }
    }
    throw new Error(`Could not find the authorization server metadata for ${issuer}`);
}

/** Registers this deployment as a public client. No secret is issued or needed. */
async function register(meta, { redirectUri, clientName }) {
    if (!meta.registration_endpoint) {
        throw new Error('This service does not support dynamic client registration.');
    }
    return json(meta.registration_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_name: clientName,
            redirect_uris: [redirectUri],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
            application_type: 'native'
        })
    });
}

/**
 * Builds the URL to send the person to, and the verifier to keep.
 *
 * PKCE is what proves the eventual token request came from whoever started the
 * flow, which is what lets this be a public client with no secret to store.
 */
function authorizeUrl(meta, { clientId, redirectUri, resource }) {
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));

    const url = new URL(meta.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    if ((meta.scopes_supported || []).length) {
        url.searchParams.set('scope', meta.scopes_supported.join(' '));
    }
    // Some servers bind the token to the resource it is for. Harmless where it
    // is ignored, required where it is not.
    if (resource) url.searchParams.set('resource', resource);

    return { url: url.toString(), verifier, state };
}

/** Exchanges the code for tokens. */
async function exchange(meta, { code, clientId, redirectUri, verifier, resource }) {
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier
    });
    if (resource) body.set('resource', resource);

    return json(meta.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    });
}

/** Spends a refresh token for a new access token. */
async function refresh(meta, { refreshToken, clientId }) {
    return json(meta.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: clientId
        })
    });
}

module.exports = { discover, register, authorizeUrl, exchange, refresh, b64url };
