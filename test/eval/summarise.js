/**
 * Reads a recorded run and says what it shows.
 *
 *   node test/eval/summarise.js test/eval/runs/<file>.json
 *   node test/eval/summarise.js <a>.json <b>.json     compare two runs
 *
 * `run.js` prints a verdict per turn while it works, which is what you want
 * while it is working and not what you want afterwards. Afterwards the
 * questions are different: which dimension fails most, which tools the model
 * actually reaches for, how many steps a turn costs, and — when two files are
 * given — what changed between one model and another.
 *
 * It reads only the recorded file. No API, no database, no cost: a run is
 * expensive enough that reading it should be free, and free means you re-read
 * it instead of re-running it.
 */

const fs = require('fs');

const C = {
    dim: (s) => `\x1b[2m${s}\x1b[0m`,
    bold: (s) => `\x1b[1m${s}\x1b[0m`,
    pass: (s) => `\x1b[32m${s}\x1b[0m`,
    fail: (s) => `\x1b[31m${s}\x1b[0m`,
    warn: (s) => `\x1b[33m${s}\x1b[0m`
};

function load(path) {
    const run = JSON.parse(fs.readFileSync(path, 'utf8'));
    const turns = run.scenarios.flatMap((s) => s.turns.map((t) => ({ ...t, scenario: s.id })));

    const dims = {};
    for (const t of turns) {
        for (const r of t.results || []) {
            const d = (dims[r.dimension] ||= { pass: 0, fail: 0, problems: [] });
            if (r.pass) d.pass++;
            else {
                d.fail++;
                d.problems.push(`${t.scenario}: ${r.problems.join('; ')}`);
            }
        }
    }

    const tools = {};
    let steps = 0, recovered = 0;
    for (const t of turns) {
        for (const s of t.steps || []) {
            steps++;
            const key = s.tool + (s.args?.metric ? `:${s.args.metric}` : '') +
                (s.args?.kind ? `:${s.args.kind}` : '');
            tools[key] = (tools[key] || 0) + 1;
            if (s.ok === false) recovered++;
        }
    }

    return {
        path,
        run,
        turns,
        dims,
        tools,
        steps,
        recovered,
        failed: turns.filter((t) => (t.results || []).some((r) => !r.pass)).length,
        // A turn with no expectations is recorded but proves nothing. Worth
        // knowing: a dataset that is mostly unchecked reads as green and is not.
        unchecked: turns.filter((t) => !(t.results || []).length).length
    };
}

function report(a) {
    console.log(C.bold(`\n${a.path}`));
    console.log(C.dim(`  ${a.run.at} · ${a.run.base}`));

    const clean = a.turns.length - a.failed;
    const line = `  ${clean}/${a.turns.length} turns clean`;
    console.log(a.failed ? C.fail(line) : C.pass(line),
        C.dim(`· ${a.steps} tool calls · ${a.recovered} recovered` +
            (a.unchecked ? ` · ${a.unchecked} turn(s) with no expectations` : '')));

    console.log(C.bold('\n  by dimension'));
    for (const [dim, d] of Object.entries(a.dims).sort((x, y) => y[1].fail - x[1].fail)) {
        const total = d.pass + d.fail;
        const tag = d.fail ? C.fail(`${d.pass}/${total}`) : C.pass(`${d.pass}/${total}`);
        console.log(`    ${dim.padEnd(12)} ${tag}`);
        for (const p of d.problems) console.log(C.dim(`      ${p}`));
    }

    console.log(C.bold('\n  what it reached for'));
    for (const [tool, n] of Object.entries(a.tools).sort((x, y) => y[1] - x[1])) {
        console.log(`    ${String(n).padStart(3)}×  ${tool}`);
    }
}

/**
 * Two runs, side by side.
 *
 * The only comparison worth printing is per scenario: a total that goes from
 * 24/29 to 25/29 says nothing about whether the same turn improved or one
 * improved while another regressed, and those are opposite outcomes.
 */
function compare(a, b) {
    console.log(C.bold(`\n  ${a.path}  →  ${b.path}`));
    const verdict = (run, id) => {
        const t = run.turns.filter((x) => x.scenario === id);
        if (!t.length) return null;
        return t.every((x) => (x.results || []).every((r) => r.pass));
    };
    const ids = [...new Set([...a.turns, ...b.turns].map((t) => t.scenario))].sort();

    for (const id of ids) {
        const [x, y] = [verdict(a, id), verdict(b, id)];
        if (x === y) continue;
        const arrow = y ? C.pass('fixed  ') : (x ? C.fail('broke  ') : C.warn('changed'));
        console.log(`    ${arrow} ${id}`);
    }
    const same = ids.filter((id) => verdict(a, id) === verdict(b, id)).length;
    console.log(C.dim(`    ${same}/${ids.length} scenarios unchanged`));
}

const files = process.argv.slice(2);
if (!files.length) {
    console.error('usage: node test/eval/summarise.js <run.json> [other-run.json]');
    process.exit(2);
}

const runs = files.map(load);
runs.forEach(report);
if (runs.length === 2) compare(runs[0], runs[1]);
console.log('');
