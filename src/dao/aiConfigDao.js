/**
 * Which model answers, and the key that pays for it.
 *
 * ── Why these moved out of the environment ───────────────────────────────
 *
 * Both used to be `OPENAI_API_KEY` and `AI_MODEL`, read once at boot. That is
 * fine for a service somebody deploys and a service somebody operates, and this
 * is neither: the dashboard is installed next to an n8n instance by the person
 * who runs the n8n instance, and asking them to edit a file on the host and
 * restart the process in order to try a different model is the same barrier the
 * documentation integration was moved out of the environment to remove.
 *
 * So the settings page writes them, and this file is the only thing that reads
 * them.
 *
 * ── The two readers ──────────────────────────────────────────────────────
 *
 *   describe()   what a page may render — configured or not, the last four
 *                characters, who set it and when, and where it came from
 *   apiKey()     the key itself, for the code that spends it
 *
 * Nothing answering an HTTP request calls the second. That is the rule
 * dao/integrationsDao states at length and it holds here for a stronger reason:
 * an OpenAI key is a bearer credential against somebody's billing account, and
 * it does not expire on its own.
 *
 * The model is not a secret and lives in `dashboard_settings` with the timezone
 * and the concurrency limit, which is why it is served to the browser with them
 * and validated by the same allowlist. The key lives in `dashboard_secrets`,
 * which nothing serves wholesale — see migration 024.
 *
 * ── Precedence, and why the environment survives ─────────────────────────
 *
 * Stored value first, environment second. The environment is kept as a fallback
 * rather than deleted because a deployment that already has a working key in its
 * `.env` must not lose the assistant on upgrade — the point of this change is to
 * make the settings page sufficient, not to make the environment forbidden. A
 * value saved in Settings always wins, and `describe()` says which one is in
 * force so an operator who sets one and sees the other is not left guessing.
 */

const localDb = require('../config/localDb');

/**
 * What to run when nobody has said.
 *
 * `gpt-5.4-mini` rather than `gpt-4o-mini`: it is the one this codebase was
 * measured against — it answers in roughly a third of the time, and it accepts
 * both `temperature` and function tools on `/v1/chat/completions`, which is the
 * pair of requirements that rules most of the alternatives out. See the note on
 * RECOMMENDED_MODEL below before changing it.
 */
const DEFAULT_MODEL = 'gpt-5.4-mini';

/**
 * What the settings page puts a "recommended" badge on.
 *
 * A recommendation rather than an allowlist, deliberately. Models are released
 * faster than this dashboard ships, and a hard list would make the newest model
 * unusable until someone edited this file — which is exactly the barrier the
 * whole change exists to remove. So anything model-shaped is accepted, and the
 * one that has actually been smoke-tested is marked.
 *
 * Two requirements that are not obvious and that a wrong choice fails loudly
 * on, both observed:
 *
 *   · it must accept `temperature` — `gpt-5-mini` rejects any value but its
 *     default, and the fold and the naming pass both set 0;
 *   · it must do function tools on `/v1/chat/completions` — `gpt-5.6-luna` does
 *     not, at all, which takes the entire tool loop with it.
 */
const RECOMMENDED_MODEL = 'gpt-5.4-mini';

const KEY_SECRET = 'openai_api_key';
const MODEL_SETTING = 'ai_model';

const now = () => new Date().toISOString();

// ==========================================================================
// The key
// ==========================================================================

async function storedKey() {
    const r = await localDb.query(
        'SELECT value, updated_by, updated_at FROM dashboard_secrets WHERE key = ?',
        [KEY_SECRET]
    );
    return r.rows[0] || null;
}

/**
 * The key, for the code that spends it. Called from no request handler.
 *
 * @returns {Promise<?string>} null when neither Settings nor the environment
 *                             has one — which is a state the assistant has to
 *                             report rather than crash on.
 */
async function apiKey() {
    const row = await storedKey();
    if (row && row.value) return row.value;
    return process.env.OPENAI_API_KEY || null;
}

/**
 * The last four characters, and nothing else.
 *
 * Enough for the one question a settings page has to answer — "is this the key I
 * think it is?" — and useless to anybody who reads it off a screen. The prefix
 * is deliberately not shown: `sk-proj-` identifies nothing, and showing both
 * ends of a secret is how a shoulder-surfed screenshot becomes most of one.
 */
function hint(value) {
    const s = String(value || '');
    return s.length >= 4 ? `…${s.slice(-4)}` : null;
}

// ==========================================================================
// What a page may see
// ==========================================================================

/**
 * The whole assistant configuration, as something safe to render.
 *
 * `keySource` and `modelSource` are here because the fallback is invisible
 * otherwise. An operator who saves a key in Settings while an old one sits in
 * the environment has to be able to see which of the two is answering their
 * questions, or the first surprising bill is unexplainable.
 */
async function describe() {
    const [row, settings] = await Promise.all([
        storedKey(),
        localDb.query('SELECT value FROM dashboard_settings WHERE key = ?', [MODEL_SETTING])
    ]);

    const stored = row && row.value ? row.value : null;
    const fromEnv = process.env.OPENAI_API_KEY || null;
    const storedModel = settings.rows[0]?.value || null;

    return {
        configured: Boolean(stored || fromEnv),
        keySource: stored ? 'settings' : (fromEnv ? 'environment' : null),
        keyHint: hint(stored || fromEnv),
        updated_by: stored ? row.updated_by : null,
        updated_at: stored ? row.updated_at : null,
        model: storedModel || process.env.AI_MODEL || DEFAULT_MODEL,
        modelSource: storedModel ? 'settings' : (process.env.AI_MODEL ? 'environment' : 'default'),
        recommendedModel: RECOMMENDED_MODEL,
        defaultModel: DEFAULT_MODEL
    };
}

/** Which model this deployment answers with. Stored, then environment, then default. */
async function model() {
    const r = await localDb.query(
        'SELECT value FROM dashboard_settings WHERE key = ?', [MODEL_SETTING]
    );
    return r.rows[0]?.value || process.env.AI_MODEL || DEFAULT_MODEL;
}

// ==========================================================================
// Writes
// ==========================================================================

/** Stores a key, replacing whatever was there. Already validated by the caller. */
async function setApiKey(value, userId) {
    await localDb.exclusive(() => localDb.execute(
        'INSERT INTO dashboard_secrets (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, ' +
        'updated_by = excluded.updated_by, updated_at = excluded.updated_at',
        [KEY_SECRET, String(value).trim(), userId || null, now()]
    ));
}

/**
 * Removes the stored key.
 *
 * Not the same as "the assistant is now off": a deployment with a key in its
 * environment falls back to it, and `describe()` will say so on the next read.
 * The alternative — refusing to fall back once someone has cleared the stored
 * one — would mean a Settings action silently overriding the host's own
 * configuration, which is the wrong direction for that authority to run.
 */
async function clearApiKey() {
    const r = await localDb.exclusive(() => localDb.execute(
        'DELETE FROM dashboard_secrets WHERE key = ?', [KEY_SECRET]
    ));
    return r.changes > 0;
}

module.exports = {
    apiKey, describe, model, setApiKey, clearApiKey,
    DEFAULT_MODEL, RECOMMENDED_MODEL, KEY_SECRET, MODEL_SETTING,
    _internal: { hint }
};
