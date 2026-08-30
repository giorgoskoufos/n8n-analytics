/**
 * Reading n8n's own user table, for login.
 *
 * The only DAO that goes to Postgres rather than the replica: authentication is
 * against n8n's live account state, not a mirror of it, so that deactivating
 * somebody in n8n locks them out here on their next attempt instead of at the
 * next sync.
 *
 * Read-only, like every other query this application sends to that database.
 */

const { pool } = require('../config/db');

// n8n's user table has changed shape across major versions — `roleSlug` is 2.x,
// 1.x used a separate role relation. The schema is probed once and the SELECT
// built from the columns that actually exist, so login keeps working on either.
let userColumnsPromise = null;

function userColumns() {
    if (!userColumnsPromise) {
        userColumnsPromise = pool
            .query(
                `SELECT column_name FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'user'`
            )
            .then((r) => new Set(r.rows.map((x) => x.column_name)))
            .catch((err) => {
                userColumnsPromise = null; // allow a retry on the next login
                throw err;
            });
    }
    return userColumnsPromise;
}

/**
 * One user by email, or undefined.
 *
 * Returns the password hash: the caller compares it, and must go on comparing
 * even when there is no user, so that a missing account costs the same time as
 * a wrong password.
 */
async function findByEmail(email) {
    const columns = await userColumns();
    const optional = ['disabled', 'mfaEnabled', 'roleSlug'].filter((c) => columns.has(c));
    const selectList = ['id', 'email', 'password', '"firstName"', '"lastName"']
        .concat(optional.map((c) => `"${c}"`))
        .join(', ');

    const r = await pool.query(
        `SELECT ${selectList} FROM "user" WHERE email = $1`,
        [email]
    );
    return r.rows[0];
}

module.exports = { findByEmail, _internal: { userColumns } };
