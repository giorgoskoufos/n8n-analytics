/**
 * OAuth credentials for the services this deployment connects to.
 *
 * ── The rule this file exists to enforce ─────────────────────────────────
 *
 * A refresh token here authorises access as the person who approved it, and the
 * one in use is valid for a year. So there are two ways to read a credential and
 * they are deliberately different functions:
 *
 *   describe()  what a page may show — connected or not, by whom, when
 *   secretFor() the token itself, for the code that spends it
 *
 * Nothing that answers an HTTP request calls the second. That is the same rule
 * F-14 established for alert channels, and it is written as two functions rather
 * than one function with a `includeSecret` flag because a flag defaults, and the
 * default that leaks is the one nobody notices.
 */

const localDb = require('../config/localDb');

const DEPLOYMENT = null;

/**
 * The stored credential for a provider and owner, or null.
 *
 * ── There is deliberately no fallback ────────────────────────────────────
 *
 * An earlier version of this fell back: a user without a credential of their own
 * used the deployment's. That is wrong here, and the reason is not about data.
 *
 * These credentials are bound to a personal identity — the docs service issues
 * them against the approver's Google account. A shared credential means every
 * question anyone asks is attributed to one person, and abuse of the service by
 * anyone with a login gets that person rate-limited, warned, or banned. The
 * consequence lands on someone who did not ask the question.
 *
 * So a lookup for a user returns that user's credential or nothing. Borrowing
 * is the failure mode this design exists to prevent, and a fallback is how
 * borrowing gets in without anyone deciding to allow it.
 *
 * `user_id` stays nullable because a single-operator deployment connected from
 * the CLI is a legitimate shape, and because the next provider may not carry a
 * personal identity at all.
 */
async function find(provider, owner = DEPLOYMENT) {
    const rows = await localDb.query(
        owner === DEPLOYMENT
            ? 'SELECT * FROM integration_credentials WHERE provider = ? AND user_id IS NULL'
            : 'SELECT * FROM integration_credentials WHERE provider = ? AND user_id = ?',
        owner === DEPLOYMENT ? [provider] : [provider, owner]
    );
    return rows.rows[0] || null;
}

/** What a settings page may render. Never the token. */
async function describe(provider, owner = DEPLOYMENT) {
    const row = await find(provider, owner);
    if (!row) return { provider, connected: false };
    return {
        provider,
        connected: true,
        scope: row.user_id ? 'user' : 'deployment',
        connected_by: row.connected_by,
        connected_at: row.connected_at,
        updated_at: row.updated_at
    };
}

/** The token, for the code that spends it. Called from no request handler. */
async function secretFor(provider, owner = DEPLOYMENT) {
    const row = await find(provider, owner);
    if (!row) return null;
    return {
        clientId: row.client_id,
        refreshToken: row.refresh_token,
        accessToken: row.access_token,
        accessExpiresAt: row.access_expires_at ? Date.parse(row.access_expires_at) : 0,
        owner: row.user_id
    };
}

/** Stores a freshly approved connection, replacing any it supersedes. */
async function save(provider, { clientId, refreshToken, accessToken, expiresInMs,
    connectedBy, owner = DEPLOYMENT }) {
    const now = new Date().toISOString();
    const expiresAt = expiresInMs
        ? new Date(Date.now() + expiresInMs).toISOString() : null;

    await localDb.exclusive(async () => {
        await localDb.execute(
            owner === DEPLOYMENT
                ? 'DELETE FROM integration_credentials WHERE provider = ? AND user_id IS NULL'
                : 'DELETE FROM integration_credentials WHERE provider = ? AND user_id = ?',
            owner === DEPLOYMENT ? [provider] : [provider, owner]
        );
        await localDb.execute(
            `INSERT INTO integration_credentials
                (provider, user_id, client_id, refresh_token, access_token,
                 access_expires_at, connected_by, connected_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [provider, owner, clientId, refreshToken, accessToken, expiresAt,
                connectedBy, now, now]
        );
    });
}

/**
 * Records a renewed access token — and a rotated refresh token if one came.
 *
 * The rotation is the part that matters. An authorization server may issue a new
 * refresh token every time the old one is spent and invalidate the old one; a
 * client that keeps the original works perfectly until the first renewal and
 * then stops, days later, with an error that points at the wrong thing.
 */
async function updateTokens(provider, owner, { accessToken, expiresInMs, refreshToken }) {
    const now = new Date().toISOString();
    const expiresAt = expiresInMs
        ? new Date(Date.now() + expiresInMs).toISOString() : null;

    const sets = ['access_token = ?', 'access_expires_at = ?', 'updated_at = ?'];
    const params = [accessToken, expiresAt, now];
    if (refreshToken) {
        sets.push('refresh_token = ?');
        params.push(refreshToken);
    }

    await localDb.exclusive(() => localDb.execute(
        `UPDATE integration_credentials SET ${sets.join(', ')} ` +
        `WHERE provider = ? AND ${owner === DEPLOYMENT ? 'user_id IS NULL' : 'user_id = ?'}`,
        owner === DEPLOYMENT ? [...params, provider] : [...params, provider, owner]
    ));
}

async function disconnect(provider, owner = DEPLOYMENT) {
    await localDb.exclusive(() => localDb.execute(
        owner === DEPLOYMENT
            ? 'DELETE FROM integration_credentials WHERE provider = ? AND user_id IS NULL'
            : 'DELETE FROM integration_credentials WHERE provider = ? AND user_id = ?',
        owner === DEPLOYMENT ? [provider] : [provider, owner]
    ));
}

module.exports = { find, describe, secretFor, save, updateTokens, disconnect, DEPLOYMENT };
