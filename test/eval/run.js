/**
 * The driver.
 *
 *   node test/eval/run.js                 every scenario
 *   node test/eval/run.js S3              only the ones whose id starts with S3
 *   node test/eval/run.js --json out.json the same run, machine-readable
 *
 * Needs a dashboard running (EVAL_BASE_URL, default http://localhost:3000) and
 * the same .env it uses. It spends real model calls — roughly one per turn,
 * plus one per tool call the model decides to make — so it is a command someone
 * runs, never something a test suite runs for them.
 *
 * ── Why it is not in `npm test` ──────────────────────────────────────────
 *
 * `npm test` is expected to be free, offline and deterministic, and this is
 * none of the three. Folding a non-deterministic paid check into it would mean
 * either the suite becomes flaky or the check gets deleted the first time it
 * costs someone a green build.
 */

require('dotenv').config({ quiet: true });

const fs = require('fs');
const { tokenFor, ask, newConversation, api, BASE } = require('./client');
const groundTruth = require('./ground-truth');
const scenarios = require('./scenarios');
const checks = require('./checks');

const args = process.argv.slice(2);
const jsonAt = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
// `--dry` builds every scenario against real ground truth and prints what would
// be asked, without sending anything. A dataset of twenty-five conversations is
// a twenty-minute run behind a rate limiter; finding a typo in scenario 24 that
// way is expensive, and this makes it free.
const dry = args.includes('--dry');
// `--clean` removes the conversations earlier runs left in the switcher. Kept
// out of the default because the whole point of seeding is that the
// conversations are there afterwards.
const clean = args.includes('--clean');
const filters = args.filter((a) => !a.startsWith('--') && a !== jsonAt);

const TITLE_PREFIX = 'eval · ';

const C = {
    dim: (s) => `\x1b[2m${s}\x1b[0m`,
    bold: (s) => `\x1b[1m${s}\x1b[0m`,
    pass: (s) => `\x1b[32m${s}\x1b[0m`,
    fail: (s) => `\x1b[31m${s}\x1b[0m`,
    warn: (s) => `\x1b[33m${s}\x1b[0m`
};

/** Who the eval runs as. A real user id, so scope resolves the way it would live. */
async function evalUser() {
    const localDb = require('../../src/config/localDb');
    const r = await localDb.query('SELECT id, email FROM users ORDER BY LENGTH(id) DESC LIMIT 1');
    if (!r.rows.length) throw new Error('No users in the replica to run as.');
    return r.rows[0];
}

/**
 * Removes memories this eval wrote on an earlier run.
 *
 * Called before and after the scenario. Before, because a memory the assistant
 * already holds makes "I have already noted that" the correct answer and the
 * expectation unmeetable. After, because a test fixture left behind in a real
 * person's memory list is the eval changing the thing it was sent to observe.
 */
async function clearMemories(token, { marker, conversationId } = {}) {
    let cleared = 0;
    try {
        const listed = await api(token, '/api/ai-memories');
        const rows = Array.isArray(listed) ? listed : (listed.memories || listed.rows || []);
        for (const m of rows) {
            // By source first. Matching on content was the obvious thing and it
            // does not work: the model writes the note in its own words, and it
            // wrote the same fact once as two separate notes and once in English,
            // so a Greek phrase lifted from the prompt matched neither. Two
            // survivors from earlier runs are what made this dataset's first
            // result wrong — every open-ended question came back scoped to a
            // folder nobody had asked about.
            const bySource = conversationId && m.source_conversation_id === conversationId;
            const byMarker = marker && String(m.content || '').includes(marker);
            if (!bySource && !byMarker) continue;
            await api(token, `/api/ai-memories/${m.id}`, { method: 'DELETE' });
            cleared++;
        }
    } catch (err) {
        console.log(C.warn(`     could not clear memories: ${err.message}`));
    }
    return cleared;
}

/** Whether this user has connected the docs, so S4 can be skipped honestly. */
async function docsAvailable(token) {
    try {
        const opts = await api(token, '/api/ai-tag-options');
        return JSON.stringify(opts).includes('docs');
    } catch {
        return false;
    }
}

function runChecks(turn, spec, subject) {
    const results = [];

    if (spec.tools) {
        results.push({ dimension: 'tool usage', ...checks.toolUsage(turn.steps, spec.tools) });
    }
    if (spec.stats) {
        results.push({ dimension: 'statistics', ...checks.statistics(turn.answer, spec.stats) });
    }
    if (spec.context) {
        results.push({
            dimension: 'context',
            ...checks.context(turn.answer, { subject, ...spec.context })
        });
    }
    if (spec.contradiction) {
        results.push({ dimension: 'coherence', ...checks.contradiction(turn.answer) });
    }
    if (turn.error) {
        results.push({
            dimension: 'delivery',
            pass: false,
            problems: [`the turn errored: ${turn.error.message || JSON.stringify(turn.error)}`]
        });
    }
    return results;
}

async function main() {
    const user = await evalUser();
    const token = tokenFor(user);
    console.log(C.dim(`→ ${BASE} as ${user.email}\n`));

    console.log(C.dim('reading ground truth from the DAOs…'));
    const truth = await groundTruth.collect();
    const p = truth.workflows.processor;
    const c = truth.workflows.callCenter;
    console.log(C.dim(
        `  instance ${truth.instance.total}/${truth.instance.errors}err · ` +
        `${p.name} ${p.total}/${p.errors}err · ${c.name} ${c.total}/${c.errors}err ` +
        `(last ${truth.days}d)\n`
    ));

    const hasDocs = await docsAvailable(token);
    const all = scenarios.build(truth);
    const chosen = all.filter((s) => !filters.length || filters.some((f) => s.id.startsWith(f)));

    if (clean) {
        const listed = await api(token, '/api/ai-conversations');
        const rows = Array.isArray(listed) ? listed : (listed.conversations || listed.rows || []);
        let n = 0;
        for (const c of rows) {
            if (!String(c.title || '').startsWith(TITLE_PREFIX)) continue;
            await api(token, `/api/ai-conversations/${c.id}`, { method: 'DELETE' });
            n++;
        }
        console.log(C.dim(`cleaned ${n} conversation(s) from earlier runs
`));
    }

    if (dry) {
        let n = 0;
        for (const scenario of chosen) {
            const skip = scenario.requires === 'docs' && !hasDocs;
            console.log(`${skip ? C.warn('SKIP') : C.bold('   ·')} ${scenario.id}`);
            for (const t of scenario.turns) {
                if (!skip) n++;
                console.log(C.dim(`       › ${t.message}`));
            }
        }
        console.log(C.bold(`
${chosen.length} scenarios, ${n} turns would be sent.`));
        console.log(C.dim('At 5 AI requests a minute, that is roughly ' +
            `${Math.ceil(n / 5)} minutes of rate-limit waiting alone.`));
        return;
    }

    const report = { base: BASE, at: new Date().toISOString(), truth, scenarios: [] };
    let turns = 0, failedTurns = 0, skipped = 0;

    for (const scenario of chosen) {
        if (scenario.requires === 'docs' && !hasDocs) {
            console.log(`${C.warn('SKIP')} ${scenario.id}`);
            console.log(C.dim('     the docs tool is not connected for this user\n'));
            skipped++;
            continue;
        }

        console.log(C.bold(scenario.id));
        console.log(C.dim(`     ${scenario.why}`));

        if (scenario.cleanMemories) {
            const n = await clearMemories(token, { marker: scenario.marker });
            if (n) console.log(C.dim(`     cleared ${n} memory/memories from an earlier run`));
        }

        const conversationId = await newConversation(token, TITLE_PREFIX + scenario.id);
        const record = { id: scenario.id, why: scenario.why, conversationId, turns: [] };
        // The subject of a scenario is whatever its first turn was about, so a
        // later turn can be checked for having kept it without restating it.
        let subject = null;

        for (const spec of scenario.turns) {
            const turn = await ask(token, {
                message: spec.message,
                conversationId,
                onWait: () => console.log(C.dim('       (rate limited — waiting)'))
            });
            turns++;

            subject = spec.context?.subject || subject;
            const results = runChecks(turn, spec, subject);
            const ok = results.every((r) => r.pass);
            if (!ok) failedTurns++;

            console.log(`  ${ok ? C.pass('PASS') : C.fail('FAIL')} ${C.dim('›')} ${spec.message}`);
            console.log(C.dim(`       tools: ${turn.steps.map((s) =>
                `${s.tool}(${Object.entries(s.args || {}).map(([k, v]) => `${k}=${v}`).join(',')})`
            ).join(' → ') || '—'}`));

            for (const r of results.filter((x) => !x.pass)) {
                for (const problem of r.problems) console.log(C.fail(`       ${r.dimension}: ${problem}`));
            }

            // A call that failed and was recovered from is not a failed turn —
            // the runner is allowed to be wrong once and fix it. It is still the
            // most interesting line on the screen, so it is never silent, even
            // when this turn declared no expectations about tools.
            for (const s of turn.steps.filter((x) => x.ok === false)) {
                console.log(C.warn(`       recovered: ${s.tool}(${JSON.stringify(s.args || {})}) — ${s.error || 'no reason recorded'}`));
            }

            record.turns.push({
                message: spec.message,
                answer: turn.answer,
                steps: turn.steps,
                results
            });
        }

        if (scenario.cleanMemories) {
            await clearMemories(token, { marker: scenario.marker, conversationId });
        }

        console.log('');
        report.scenarios.push(record);
    }

    const failedDims = {};
    for (const s of report.scenarios) {
        for (const t of s.turns) {
            for (const r of t.results) {
                if (!r.pass) failedDims[r.dimension] = (failedDims[r.dimension] || 0) + 1;
            }
        }
    }

    console.log(C.bold('─'.repeat(64)));
    const line = `${turns - failedTurns}/${turns} turns clean`;
    console.log(failedTurns ? C.fail(line) : C.pass(line), skipped ? C.dim(`· ${skipped} scenario(s) skipped`) : '');
    for (const [dim, n] of Object.entries(failedDims).sort((a, b) => b[1] - a[1])) {
        console.log(C.fail(`  ${n}× ${dim}`));
    }

    if (jsonAt) {
        fs.writeFileSync(jsonAt, JSON.stringify(report, null, 2));
        console.log(C.dim(`\nfull transcript → ${jsonAt}`));
    }

    process.exitCode = failedTurns ? 1 : 0;
}

main().then(
    () => setTimeout(() => process.exit(process.exitCode || 0), 100),
    (err) => {
        console.error(C.fail(`\n${err.stack || err.message}`));
        process.exit(2);
    }
);
