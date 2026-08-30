const jwt = require('jsonwebtoken');
const localDb = require('../config/localDb');
const { resolveScopeFor } = require('../utils/scope');
const log = require('../utils/logger').logger('AUTH');
const JWT_SECRET = process.env.DASHBOARD_JWT_SECRET;

// Fail at boot rather than at the first login. A missing secret makes jwt.sign()
// throw on every request; a short one is brute-forceable offline from a single
// captured token, which lets an attacker mint tokens for any user.
const MIN_SECRET_LENGTH = 32;
if (!JWT_SECRET) {
    throw new Error(
        'DASHBOARD_JWT_SECRET is not set. Generate one with: openssl rand -base64 48'
    );
}
if (JWT_SECRET.length < MIN_SECRET_LENGTH) {
    throw new Error(
        `DASHBOARD_JWT_SECRET is too short (${JWT_SECRET.length} chars, minimum ${MIN_SECRET_LENGTH}). ` +
        'Generate one with: openssl rand -base64 48'
    );
}

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // reads "Bearer TOKEN"

    if (!token) return res.status(401).json({ error: 'Authentication required (Missing Token)' });

    jwt.verify(token, JWT_SECRET, async (err, user) => {
        // 401, not 403. The two are not interchangeable to the frontend: guard.js
        // treats "not authenticated" as a reason to clear the token and bounce to
        // the login page, and "not permitted" as a message to show the user. While
        // a bad token answered 403, every authorization refusal in the app logged
        // the user out instead of telling them why.
        if (err) return res.status(401).json({ error: 'Invalid or expired token' });
        req.user = user;

        // Every user-owned table (chat conversations, memories, ...) has a
        // FOREIGN KEY on this row. A token stays valid for 8h independent of
        // what the local SQLite file holds, so if that file was ever reset — a
        // fresh volume, a wiped replica — while a session was still live, the
        // first write under the old token failed with a FOREIGN KEY constraint
        // instead of a clear "log in again". Syncing the row on every request,
        // not just at login, closes that gap for good.
        try {
            await localDb.execute(
                'INSERT INTO users (id, email) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET email=excluded.email',
                [user.id, user.email]
            );
        } catch (dbErr) {
            log.error(`Could not sync local user row for ${user.email}:`, dbErr.message);
        }

        next();
    });
};

// n8n 2.x role slugs. Anything else ('global:member', project-scoped roles) is
// treated as unprivileged.
const ELEVATED_ROLES = new Set(['global:owner', 'global:admin']);

/**
 * Gate for actions that cost the production n8n instance real work, such as
 * forcing a full ETL pass.
 *
 * Fails OPEN when the role is unknown. n8n 1.x has no roleSlug column, so login
 * stores null and there is genuinely no way to tell an owner from a member —
 * denying there would take a working feature away from every user on that
 * version. The per-user rate limit is what bounds the abuse; this is defence in
 * depth on top of it, not the only control.
 */
const requireElevatedRole = (req, res, next) => {
    const role = req.user && req.user.role;
    if (!role) return next();
    if (ELEVATED_ROLES.has(role)) return next();

    log.warn(`Elevated action refused for role "${role}" (user ${req.user.id})`);
    return res.status(403).json({
        error: 'Only n8n owners and admins can trigger this action.'
    });
};

/**
 * Attaches req.scope — which workflows this request may touch.
 *
 * A middleware rather than a call inside each controller, so a handler added
 * later cannot forget to ask. Ordering matters: it reads req.user, so it must
 * run after authenticateToken.
 *
 * The rules live in utils/scope.js; this only carries the answer onto the
 * request and turns a lookup failure into a 500 instead of an unscoped read.
 */
const resolveScope = async (req, res, next) => {
    try {
        req.scope = await resolveScopeFor(req.user);
        next();
    } catch (err) {
        log.error('Could not resolve access scope:', err.message);
        res.status(500).json({ error: 'Could not determine access rights for this request.' });
    }
};

module.exports = { authenticateToken, requireElevatedRole, resolveScope, JWT_SECRET };
