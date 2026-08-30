/**
 * The provider client, built from whatever the key is right now.
 *
 * ── Why this is not `new OpenAI(...)` at require time any more ───────────
 *
 * It used to be exactly that, one line, reading `process.env.OPENAI_API_KEY`.
 * That is only correct while the key can never change without the process
 * restarting — and the key is a settings field now (see dao/aiConfigDao), so a
 * client captured at boot is a client holding the key the operator has just
 * replaced. The failure is the quiet kind: Settings says connected, every answer
 * still fails with a 401 against the old credential, and nothing in the UI is
 * wrong enough to point at.
 *
 * So the key is read per call and the client is memoised against it. The read is
 * one indexed lookup in the local SQLite file, against a model call that takes
 * the better part of a second — the ordering of those two costs is the whole
 * argument for not caching it more cleverly, and a cache with an invalidation
 * hook is one more thing that can be forgotten at exactly one call site.
 *
 * ── The shape is deliberately unchanged ──────────────────────────────────
 *
 * Callers still do `openai.chat.completions.create(...)`, and the tests still
 * replace this whole module through `require.cache` with an object of that
 * shape. Anything added here that a caller depends on is something the stub
 * would also have to grow, so nothing is.
 */

const { OpenAI } = require('openai');
const aiConfig = require('../dao/aiConfigDao');
require('dotenv').config();

/** The last key seen, and the client built for it. One entry: keys change rarely. */
let memo = { key: null, client: null };

/**
 * Raised when nothing anywhere holds a key.
 *
 * A named error rather than a generic one so the request layer can turn it into
 * the sentence that actually helps — "add a key in Settings" — instead of the
 * 500 that says the assistant is broken when it is merely unconfigured.
 */
class NotConfiguredError extends Error {
    constructor() {
        super('No OpenAI API key is configured. Add one in Settings → Integrations.');
        this.name = 'NotConfiguredError';
        this.notConfigured = true;
    }
}

async function client() {
    const key = await aiConfig.apiKey();
    if (!key) throw new NotConfiguredError();
    if (memo.key !== key) memo = { key, client: new OpenAI({ apiKey: key }) };
    return memo.client;
}

const openai = {
    chat: {
        completions: {
            // `create` already returns a promise (a stream, when asked for one),
            // so awaiting the client first costs the caller nothing it was not
            // already awaiting.
            create: async (args) => (await client()).chat.completions.create(args)
        }
    },
    NotConfiguredError
};

module.exports = openai;
