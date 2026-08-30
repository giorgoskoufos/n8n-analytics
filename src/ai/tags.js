/**
 * `@tag` — pinning a question to a specific thing, or to a specific tool.
 *
 * Two different gestures share one symbol, and they do genuinely different work:
 *
 *   @tool:docs                  COMPELS the call. Not a hint, not a preference —
 *                               `tool_choice` in the runner. The user asked for
 *                               the documentation, so the documentation is read.
 *   @workflow:CallCenterPerMinute
 *   @execution:995442           names a thing. Resolved here to an id and handed
 *                               to the model as a fact, so it does not have to
 *                               spend a turn on `search_catalog` guessing which
 *                               of four similarly-named workflows was meant.
 *
 * ── The rule that must not be lost ───────────────────────────────────────
 *
 * The server does not trust an id the client sends. A tag arrives as TEXT and is
 * re-resolved here, through the same scoped catalogue and the same scoped views
 * every tool reads — and if it does not resolve there, it is rejected.
 *
 * That is not defensive tidiness. The autocomplete runs against the caller's own
 * scope, so the UI cannot offer a workflow from another project; a hand-written
 * POST can say anything. Were the id taken at face value, `@workflow:<id>` would
 * pin the answer to somebody else's workflow — through a tool chain that is
 * otherwise scoped end to end. Resolution IS the check.
 *
 * ── Names and ids are both accepted, and that is not a loosening ─────────
 *
 * A hand-typed tag names a thing; the dropdown inserts an id. Both are looked up
 * the same way, in the same scoped index, so neither is trusted more than the
 * other — an id that is not in the caller's catalogue resolves to nothing just
 * as a made-up name does.
 *
 * The id form exists because names are not unique. Two workflows called "Saved
 * Messages v2", one archived and one live, is the ordinary state of an n8n
 * instance, and a picker that showed the user one specific row has information
 * the name alone has lost. So the picker keeps the id in the text and shows the
 * name on the chip.
 *
 * ── Why a rejected tag is not silently dropped ───────────────────────────
 *
 * A tag the user could see themselves typing has to have a visible outcome. If
 * an unresolvable one simply vanished, the answer would come back about
 * something adjacent and read as though the tag had been honoured. So a rejected
 * tag travels into the preamble as an explicit "this does not exist here, say
 * so" — the model reports it, in the same place the answer appears.
 */

const catalog = require('./catalog');
const readonlyDb = require('../config/readonlyDb');

// Enough for "compare these three workflows", short of a message that is one
// long tag list and no question.
const MAX_TAGS = 8;

// Each forced tool costs a whole step out of the runner's six, and a turn that
// spends five of them on compelled calls has no room left to follow what it
// found.
const MAX_FORCED = 3;

/**
 * `@category:value`, with quotes when the value has spaces.
 *
 * Bare values stop at whitespace, so `@workflow:Call Center` would capture only
 * "Call"; the dropdown emits `@workflow:"Call Center"` for those. Both forms are
 * accepted because the syntax is typeable by hand, not only insertable.
 *
 * An unknown category is not an error — it is almost certainly not a tag at all.
 * `user@host:8080` matches this shape, and rejecting the message over it would
 * be worse than ignoring it.
 */
const TAG_RE = /@([a-z_]{2,12}):(?:"([^"\n]{1,120})"|([^\s"@,;]{1,120}))/gi;

/**
 * What a person types, and the tool it compels.
 *
 * Aliases rather than tool names: `@tool:ask_n8n_docs` is the function's name,
 * not the user's word for it. The values here are the only names that ever reach
 * `tool_choice` — an arbitrary string from the client cannot become one.
 */
const TOOL_ALIASES = {
    docs: 'ask_n8n_docs',
    n8n_docs: 'ask_n8n_docs',
    documentation: 'ask_n8n_docs',
    sql: 'run_sql',
    query: 'run_sql',
    analytics: 'get_analytics',
    metric: 'get_analytics',
    metrics: 'get_analytics',
    search: 'search_catalog',
    catalog: 'search_catalog',
    drilldown: 'drill_down',
    drill_down: 'drill_down',
    instance: 'describe_instance'
};

/** Entity categories → the catalogue kind each is resolved through. */
const ENTITY_KINDS = {
    workflow: 'workflow',
    folder: 'folder',
    tag: 'tag',
    project: 'project',
    node: 'node_type',
    node_type: 'node_type',
    error: 'error_group',
    error_group: 'error_group'
};

/** Every category the syntax recognises — the autocomplete reads this too. */
const CATEGORIES = ['tool', 'execution', ...Object.keys(ENTITY_KINDS)];

/**
 * The way back: a catalogue kind to the word a user types.
 *
 * `node_type` and `error_group` are the index's names for things nobody calls
 * that, so the picker offers `@node:` and `@error:` and this is where the two
 * vocabularies meet. Built from ENTITY_KINDS rather than written out again — the
 * first spelling of each kind wins, which is the short one by construction.
 */
const CATEGORY_FOR_KIND = Object.entries(ENTITY_KINDS).reduce((acc, [category, kind]) => {
    if (!acc[kind]) acc[kind] = category;
    return acc;
}, {});

/**
 * Pulls the tags out of a message.
 *
 * The message itself is left alone. Stripping the tags would make the history
 * disagree with what the user actually typed, and the model reads the preamble
 * for the resolved values anyway — seeing `@workflow:X` in the question beside
 * "X is id abc" in the preamble costs nothing and keeps the record honest.
 */
function parse(text) {
    const out = [];
    const seen = new Set();

    for (const m of String(text || '').matchAll(TAG_RE)) {
        const category = m[1].toLowerCase();
        if (category !== 'tool' && category !== 'execution' && !ENTITY_KINDS[category]) continue;

        const value = (m[2] === undefined ? m[3] : m[2]).trim();
        if (!value) continue;

        const key = `${category}:${value.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);

        out.push({ raw: m[0], category, value });
        if (out.length >= MAX_TAGS) break;
    }
    return out;
}

/** Whether the message asks for a tool by name — needed before the tools exist. */
function forcedAliases(tags) {
    return tags
        .filter((t) => t.category === 'tool')
        .map((t) => TOOL_ALIASES[t.value.toLowerCase()])
        .filter(Boolean);
}

async function resolveEntity(kind, value, visibleIds) {
    const exact = await catalog.resolveExact({ kind, value, scope: visibleIds });
    if (exact.length === 1) return { ok: true, entry: exact[0] };
    if (exact.length > 1) {
        // Not a rare edge. On this instance "Saved Messages v2" is two
        // workflows — an archived copy and the live one — and picking either
        // would answer a question about the wrong one without ever saying so.
        // The ids go into the message because they are how the user gets
        // unstuck: `@workflow:<id>` resolves through this same path.
        return {
            ok: false,
            why: `${exact.length} ${kind}s are called "${value}" — tag one by id instead: ` +
                exact.map((r) => `${r.id}${r.detail ? ` (${r.detail})` : ''}`).join(', ')
        };
    }

    // Nothing matched exactly. One fuzzy hit is still an unambiguous choice —
    // and still one this caller was allowed to see, because the search reads the
    // same scoped index. Several hits are a question, not an answer, so they are
    // named rather than guessed between.
    const near = await catalog.search({ query: value, kind, limit: 5, scope: visibleIds });
    if (near.length === 1) return { ok: true, entry: near[0] };
    if (near.length === 0) {
        return { ok: false, why: `no ${kind} you can see is called "${value}"` };
    }
    return {
        ok: false,
        why: `"${value}" could be any of: ${near.map((r) => r.name).join(', ')}`
    };
}

/**
 * Executions are not in the catalogue, and should not be.
 *
 * There are 535,000 of them and they have no names — indexing them would be a
 * half-million-row FTS table to let somebody tag a number they already know. The
 * check they need is the same one, though: is this row visible to this caller.
 * `ai_executions` answers it, because the view carries the scope itself.
 */
async function resolveExecution(value, visibleIds) {
    if (!/^\d{1,18}$/.test(value)) {
        return { ok: false, why: `"${value}" is not an execution id — those are numbers` };
    }
    const rows = await readonlyDb.query(
        `SELECT id, workflow_id, status, mode, started_at
           FROM ai_executions WHERE id = ? LIMIT 1`,
        [value], { scope: visibleIds }
    );
    if (rows.length === 0) {
        return { ok: false, why: `there is no execution ${value} in the data you can see` };
    }
    return { ok: true, entry: rows[0] };
}

/**
 * Turns parsed tags into forced tools and a preamble.
 *
 * @param {object[]} tags     from parse()
 * @param {object}   opts
 * @param {object}   opts.ctx    { scope, visibleIds, userId }
 * @param {object[]} opts.tools  the built tool list — the only source of truth
 *                               for what can be forced. A tag naming a tool that
 *                               is off, or that this user never connected, is
 *                               rejected here rather than sent to the provider
 *                               as a `tool_choice` for a function it cannot see.
 */
async function resolve(tags, { ctx, tools }) {
    const available = new Set((tools || []).map((t) => t.function && t.function.name));
    const forced = [];
    const resolved = [];
    const rejected = [];

    for (const tag of tags) {
        if (tag.category === 'tool') {
            const name = TOOL_ALIASES[tag.value.toLowerCase()];
            if (!name) {
                rejected.push({ ...tag, why: `there is no "${tag.value}" tool` });
            } else if (!available.has(name)) {
                rejected.push({ ...tag, why: 'that tool is not available in this conversation' });
            } else if (!forced.includes(name) && forced.length < MAX_FORCED) {
                forced.push(name);
            }
            continue;
        }

        const outcome = tag.category === 'execution'
            ? await resolveExecution(tag.value, ctx.visibleIds)
            : await resolveEntity(ENTITY_KINDS[tag.category], tag.value, ctx.visibleIds);

        if (outcome.ok) resolved.push({ ...tag, entry: outcome.entry });
        else rejected.push({ ...tag, why: outcome.why });
    }

    return { forced, resolved, rejected, preamble: preambleFor({ forced, resolved, rejected }) };
}

function describeEntry(tag) {
    const e = tag.entry;
    if (tag.category === 'execution') {
        return `execution ${e.id} — workflow id \`${e.workflow_id}\`, status ${e.status}` +
            (e.started_at ? `, started ${e.started_at}` : '');
    }
    return `${tag.category} "${e.name}" — id \`${e.id}\`` + (e.detail ? ` (${e.detail})` : '');
}

/**
 * The extra system turn.
 *
 * A system message rather than a prefix on the question, because it is not
 * something the user said — and because it must not be written to the history,
 * where the next turn would replay ids for a question nobody asked again.
 */
function preambleFor({ forced, resolved, rejected }) {
    if (!forced.length && !resolved.length && !rejected.length) return null;
    const lines = ['## Tags in this question'];

    if (resolved.length) {
        lines.push(
            '',
            'The user pointed at these explicitly. They are already resolved against what this ' +
            'user is permitted to see — treat the ids as given and do NOT call `search_catalog` ' +
            'for them:',
            '',
            ...resolved.map((t) => `- ${describeEntry(t)}`),
            '',
            'The question is about these. If an analysis you run does not take one of them as a ' +
            'filter, drill into it rather than answering about the instance as a whole.'
        );
    }

    if (forced.length) {
        lines.push(
            '',
            `The user asked for ${forced.map((f) => `\`${f}\``).join(' and ')} specifically, and ` +
            'it will be called before you answer. Put what comes back to use — do not call it and ' +
            'then answer around it.'
        );
    }

    if (rejected.length) {
        lines.push(
            '',
            'These could not be resolved. Say so plainly in your answer — do not substitute ' +
            'something similar, and do not answer as though they had not been asked for:',
            '',
            ...rejected.map((t) => `- \`${t.raw}\` — ${t.why}`)
        );
    }

    return lines.join('\n');
}

module.exports = {
    parse, resolve, forcedAliases,
    CATEGORIES, ENTITY_KINDS, CATEGORY_FOR_KIND, TOOL_ALIASES, MAX_TAGS, MAX_FORCED,
    _internal: { TAG_RE, preambleFor, resolveEntity, resolveExecution }
};
