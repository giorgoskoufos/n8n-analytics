/**
 * F-12. Turning one execution's raw trace into node-level facts.
 *
 * Pure: it takes an already-parsed `execution_data.data` payload and returns
 * counts and durations. It never returns a value out of the payload — no item
 * contents, no parameters, no headers — because everything that calls this is
 * either storing the result in the replica or sending it to a browser, and the
 * payload is real customer data. What comes out is arithmetic about the data,
 * not the data.
 *
 * Shapes handled, both seen in the wild:
 *   { resultData: { runData, error, lastNodeExecuted }, executionData, ... }
 *   [ { resultData: … }, … ]        (older array-wrapped form)
 *
 * Measured against 600 real executions on the instance this was built for; the
 * comments below say which numbers came from that rather than from the docs.
 */

/** Sum of the items across every output branch of one run. */
function itemsOut(run) {
    const main = run && run.data && run.data.main;
    if (!Array.isArray(main)) return null;      // the node produced no output
    let n = 0;
    for (const branch of main) {
        if (Array.isArray(branch)) n += branch.length;
    }
    return n;
}

/**
 * The chain of causes behind an error, outermost first.
 *
 * Walks both `cause` and `context.cause`, because n8n uses either depending on
 * where the error was wrapped.
 *
 * On the instance this was written against the chain is **always length one**:
 * 300 failed executions, zero with a nested cause, at the run level and at the
 * top level both. That is worth knowing rather than assuming — the feature was
 * specified as "the real deepest error.cause chain", and here there is no depth
 * to find. It is extracted anyway because the cost is a while loop and the day
 * an HTTP node wraps a socket error it will be the only place the real reason
 * appears.
 */
function causeChain(error, limit = 8) {
    const chain = [];
    let node = error;
    const seen = new Set();
    while (node && typeof node === 'object' && chain.length < limit) {
        // Payloads are `flatted`-encoded, which means shared references — a
        // cause that points back at its own parent is representable, and would
        // otherwise spin here forever.
        if (seen.has(node)) break;
        seen.add(node);

        chain.push({
            name: typeof node.name === 'string' ? node.name : null,
            message: typeof node.message === 'string' ? node.message
                : typeof node.description === 'string' ? node.description : null,
            code: node.code ?? node.httpCode ?? null
        });
        node = node.cause || (node.context && node.context.cause);
    }
    return chain;
}

/** The root of the payload, whichever of the two shapes it is. */
function rootOf(data) {
    if (!data || typeof data !== 'object') return null;
    if (data.resultData) return data;
    if (Array.isArray(data) && data[0] && typeof data[0] === 'object') return data[0];
    return data;
}

/**
 * Everything node-level about one execution.
 *
 * `wallMs` is optional and comes from the execution row rather than the payload
 * — the trace knows how long each node took, not how long the execution took.
 */
function summariseTrace(data, wallMs = null) {
    const root = rootOf(data);
    const resultData = root && root.resultData;
    const runData = resultData && resultData.runData;

    const empty = {
        has_run_data: false,
        nodes: [],
        flow: [],
        total_node_ms: 0,
        wall_ms: wallMs,
        overlap_ratio: null,
        node_count: 0,
        run_count: 0,
        failed_nodes: 0,
        last_node: (resultData && resultData.lastNodeExecuted) || null,
        error: null
    };

    const topError = resultData && resultData.error;
    if (topError) {
        empty.error = {
            node: (topError.node && topError.node.name) || null,
            node_type: (topError.node && topError.node.type) || null,
            chain: causeChain(topError),
            // Which item of the batch failed. Present on 238 of 300 failures
            // here, and it is the difference between "this node is broken" and
            // "row 74 of 135 has a bad value in it".
            item_index: topError.context && Number.isInteger(topError.context.itemIndex)
                ? topError.context.itemIndex : null,
            // n8n's own sub-messages. Rarer (15 of 300) but they carry the
            // upstream service's wording when they are there.
            messages: Array.isArray(topError.messages)
                ? topError.messages.filter((m) => typeof m === 'string').slice(0, 5)
                : []
        };
    }

    // A real case, not a defensive one: one of the twelve slowest executions in
    // three days ran for 25 seconds and carries no node data. Reporting zero
    // nodes as "0 ms spent" would be a lie about where the time went.
    //
    // An EMPTY runData object counts as none. That execution — cancelled after
    // 25 seconds — has the key present and nothing in it, and reporting
    // has_run_data: true beside zero nodes and an overlap of 0.00 invites the
    // reader to believe the trace was read and the workflow did nothing.
    if (!runData || typeof runData !== 'object' || Object.keys(runData).length === 0) return empty;

    const nodes = [];
    let totalMs = 0;
    let runCount = 0;

    for (const name of Object.keys(runData)) {
        const runs = runData[name];
        if (!Array.isArray(runs) || runs.length === 0) continue;

        let ms = 0;
        let items = 0;
        let itemsKnown = false;
        let branches = 0;
        let failed = 0;
        const channels = new Set();
        let firstStart = null;
        let lastEnd = null;

        for (const run of runs) {
            const t = Number(run && run.executionTime);
            if (Number.isFinite(t)) ms += t;

            const start = Number(run && run.startTime);
            if (Number.isFinite(start)) {
                if (firstStart === null || start < firstStart) firstStart = start;
                const end = start + (Number.isFinite(t) ? t : 0);
                if (lastEnd === null || end > lastEnd) lastEnd = end;
            }

            const out = itemsOut(run);
            if (out !== null) { items += out; itemsKnown = true; }
            const main = run && run.data && run.data.main;
            if (Array.isArray(main)) branches = Math.max(branches, main.length);
            // Which connection types the node emitted on. An AI sub-node — a
            // chat model, a memory, a tool — never writes to `main`, so it has
            // no item count and that is correct rather than missing. Naming the
            // channel is the difference between "produced nothing" and "is not
            // that kind of node": measured, `OpenAI Chat Model` is the single
            // most expensive node in the slowest execution on this instance and
            // it has no main output at all.
            if (run && run.data && typeof run.data === 'object') {
                for (const channel of Object.keys(run.data)) channels.add(channel);
            }

            if (run && (run.executionStatus === 'error' || run.error)) failed++;
        }

        runCount += runs.length;
        totalMs += ms;

        const last = runs[runs.length - 1];
        nodes.push({
            name,
            // The trace does not carry node types — only the failing node's
            // error does. Null rather than a guess.
            type: (last && last.error && last.error.node && last.error.node.type) || null,
            runs: runs.length,
            ms,
            // Null, not zero: a node that errored produced no output, and that
            // is a different fact from a node that produced an empty list.
            items_out: itemsKnown ? items : null,
            branches,
            channels: [...channels],
            is_sub_node: channels.size > 0 && !channels.has('main'),
            failed_runs: failed,
            status: failed > 0 ? 'error' : (last && last.executionStatus) || 'unknown',
            error_message: (last && last.error &&
                (last.error.message || last.error.description)) || null,
            error_chain: last && last.error ? causeChain(last.error) : [],
            started_at: firstStart,
            ended_at: lastEnd
        });
    }

    nodes.sort((a, b) => b.ms - a.ms);

    // A node can fail inside an execution the database records as successful:
    // measured here on a real run where `MCP Client` errored four times and the
    // execution's status is `success`. Every error rate in this dashboard is
    // computed from that status, so those failures are invisible to all of
    // them. Counted here so the one view that can see them says so.
    const failedNodes = nodes.filter((n) => n.failed_runs > 0).length;

    return {
        has_run_data: true,
        nodes,
        flow: itemFlow(runData),
        total_node_ms: totalMs,
        wall_ms: wallMs,
        // Branches run in parallel, so node time legitimately exceeds wall time
        // — measured at 174% on this instance. Reported as a ratio rather than
        // clamped, because ">100%" is the signal that the workflow fans out,
        // and a percentage-of-wall column that silently caps at 100 would hide
        // exactly that. Null when there is nothing to compare against.
        overlap_ratio: wallMs && wallMs > 0 ? +(totalMs / wallMs).toFixed(2) : null,
        node_count: nodes.length,
        run_count: runCount,
        failed_nodes: failedNodes,
        last_node: (resultData && resultData.lastNodeExecuted) || null,
        error: empty.error
    };
}

/**
 * Items in versus items out, per edge, for silent data loss.
 *
 * The linkage is exact rather than inferred: every run carries
 * `source[].previousNode`, `previousNodeOutput` and `previousNodeRun`, so the
 * input to a run is a specific branch of a specific earlier run — present on
 * every sourced run in the sample (590 of 590 failed, 835 of 835 successful).
 *
 * Trigger nodes have `source: []`. Their input is *unknown*, not zero, and they
 * are left out entirely: an edge is a claim about two nodes.
 */
function itemFlow(runData) {
    /** items on one output branch of one specific run. */
    const branchLength = (nodeName, runIndex, output) => {
        const runs = runData[nodeName];
        if (!Array.isArray(runs)) return null;
        const run = runs[runIndex];
        const main = run && run.data && run.data.main;
        if (!Array.isArray(main)) return null;
        const branch = main[output];
        return Array.isArray(branch) ? branch.length : null;
    };

    const edges = new Map();

    for (const name of Object.keys(runData)) {
        const runs = runData[name];
        if (!Array.isArray(runs)) continue;

        runs.forEach((run, runIndex) => {
            const sources = Array.isArray(run && run.source) ? run.source : [];
            for (const src of sources) {
                if (!src || typeof src.previousNode !== 'string') continue;

                const inCount = branchLength(
                    src.previousNode,
                    Number.isInteger(src.previousNodeRun) ? src.previousNodeRun : 0,
                    Number.isInteger(src.previousNodeOutput) ? src.previousNodeOutput : 0
                );
                const outCount = itemsOut(run);
                if (inCount === null || outCount === null) continue;

                const key = `${src.previousNode} ${name}`;
                const edge = edges.get(key) || {
                    from: src.previousNode, to: name, items_in: 0, items_out: 0, runs: 0
                };
                edge.items_in += inCount;
                edge.items_out += outCount;
                edge.runs++;
                edges.set(key, edge);
            }
        });
    }

    return [...edges.values()]
        .map((e) => ({ ...e, lost: e.items_in - e.items_out }))
        .sort((a, b) => b.lost - a.lost);
}

module.exports = { summariseTrace, causeChain, itemFlow, _internal: { itemsOut, rootOf } };
