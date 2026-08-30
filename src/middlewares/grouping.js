/**
 * Refuses a request that filters by an id naming nothing.
 *
 * ── Why a middleware and not a line in each handler ──────────────────────
 *
 * `groupingClause` appears at 27 call sites across two controllers. Adding a
 * check to each of them is 27 chances to forget, and the 28th handler — the one
 * written next month — starts life without it. That is the same argument
 * `resolveScope` makes for being a middleware, and it is the stronger argument
 * here: a missing scope check is a leak somebody eventually notices, while a
 * missing existence check produces a page of zeroes that looks completely
 * normal.
 *
 * It runs after `resolveScope` and before any handler, on the routers that
 * accept these filters. Only a request that actually carries one of the four
 * touches the database.
 *
 * ── Why it is not in `groupingClause` itself ─────────────────────────────
 *
 * That function is a pure SQL-fragment builder with no I/O — it is required by
 * `dao/shared.js` and called from inside `filterFor`, which is synchronous and
 * runs in the middle of building a query. Making it async would make every DAO
 * async at its innermost point for a check that belongs at the edge, once, per
 * request.
 */

const { assertGroupingExists } = require('../dao/shared');
const log = require('../utils/logger').logger('API');

/** The four query parameters that name an entity by id. */
const KEYS = ['workflow', 'folder', 'tag', 'project'];

const verifyGrouping = async (req, res, next) => {
    const asked = {};
    for (const key of KEYS) {
        const value = req.query?.[key];
        if (value !== undefined && value !== null && value !== '') asked[key] = value;
    }
    // The overwhelmingly common case: no filter, no query, no cost.
    if (Object.keys(asked).length === 0) return next();

    try {
        await assertGroupingExists(asked);
        next();
    } catch (err) {
        // `expected` marks a rejection a DAO raised on purpose — here, always the
        // 400 above. Anything else is a fault in the replica and must not be
        // reported to the caller as though they had sent a bad id.
        if (err.expected) return res.status(err.status).json({ error: err.message });
        log.error('Could not verify grouping ids:', err.message);
        res.status(500).json({ error: 'Could not verify the filter for this request.' });
    }
};

module.exports = { verifyGrouping, KEYS };
