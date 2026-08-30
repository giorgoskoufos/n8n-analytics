# The assistant, for developers

*Everything [how-it-works.md](how-it-works.md) leaves out: where a turn goes,
what stops it reading things it should not, and how to add to it.*

---

## The shape of it

```
POST /api/ai-chat/stream
   │
   ├── prepare()                    controllers/aiController.js
   │     resolve conversation · load memories + the whole thread, steps and all
   │     resolve @tags through the scoped catalogue
   │     build the tool list for THIS user
   │
   ├── turns.create()               ai/turns.js       ← the answer now outlives the request
   │
   ├── run()                        ai/runner.js      ← the tool-calling loop
   │     └── execute()              ai/execute.js     ← tool name → real work
   │           ├── get_analytics    ai/tools/analytics.js  → src/dao/*
   │           ├── drill_down       ai/tools/drilldown.js  → src/dao/*
   │           ├── search_catalog   ai/catalog/index.js    (FTS5 over the replica)
   │           ├── run_sql          config/readonlyDb.js   (optional escape hatch)
   │           ├── remember         dao/conversationsDao.js
   │           └── ask_n8n_docs     ai/tools/docs.js       (kapa MCP, per-user OAuth)
   │
   ├── persist()                    history + the steps summary
   └── name()                       ai/title.js       ← once, on the opening exchange
```

### The files

| File | What it owns |
|---|---|
| `controllers/aiController.js` | The HTTP surface, and `prepare()` — everything one turn needs, assembled once |
| `ai/runner.js` | The tool-calling loop and its bounds |
| `ai/execute.js` | Tool name → the work. The only place that maps arguments onto DAO calls |
| `ai/tools/index.js` | The tool registry and the shared argument envelope |
| `ai/tools/analytics.js` | The 20 named analyses. One entry = one metric |
| `ai/tools/drilldown.js` | The four "look at this one thing" tools |
| `ai/tools/docs.js` | The n8n documentation MCP client |
| `ai/catalog/index.js` | FTS5 index over names, rebuilt per scope, TTL-cached |
| `ai/tags.js` | `@` parsing, and re-resolution through the scoped catalogue |
| `ai/prompt.js` | The system prompt, the memory block, the how-to-read-this-thread block |
| `ai/turns.js` | A turn that survives the client disconnecting |
| `ai/history.js` | Stored rows → the transcript, with each answer's analyses beside it |
| `ai/title.js` | Naming a thread from its opening exchange |
| `dao/aiConfigDao.js` | Which model answers, and the key that pays for it |
| `ai/oauth.js` | Shared OAuth (used by the UI and the CLI script) |
| `config/aiViews.js` | The `ai_*` views — the read surface, and most of the safety |
| `config/readonlyDb.js` | A second SQLite handle opened `OPEN_READONLY` |
| `utils/sqlGuard.js` | The statement check. The *weakest* of the four defences |

---

## The loop

`run()` streams from the first call and reassembles tool-call fragments as they
arrive, rather than making a non-streaming call to discover whether tools were
wanted and a second one to stream prose. That is one whole model round trip per
turn, saved.

Bounds, and why each exists:

| | Default | Env | Why |
|---|---|---|---|
| `MAX_STEPS` | 6 | `AI_MAX_STEPS` | Enough for resolve → measure → drill → confirm. A model that keeps calling tools without concluding is a loop that bills per turn |
| `MAX_RESULT_CHARS` | 12,000 | `AI_MAX_RESULT_CHARS` | Tool output re-enters the context. Truncation is **announced** in the result — a silently cut list is one the model describes as complete |
| `MAX_ROWS` | 500 | — | `run_sql` only |
| query timeout | 8s | `AI_QUERY_TIMEOUT_MS` | |

**Tool failures are returned to the model, not thrown.** A bad metric name or a
rejected statement is something it can correct on the next step; turning that
into a 500 throws away a conversation over a typo. Failed steps are recorded
with their reason and surfaced in the UI.

---

## Safety, strongest first

Four mechanisms. The ordering is the point: the one that looks like the security
control is the weakest of them.

**1 · The connection cannot write.** `config/readonlyDb.js` opens its own handle
with `OPEN_READONLY`. A write is `SQLITE_READONLY` from the engine, not a rule
in JavaScript.

**2 · The columns are not there.** The `ai_*` views in `config/aiViews.js` are
the entire read surface. `ai_errors` has no `input_data` column, so
`SELECT input_data FROM ai_errors` is `no such column` — a database error, not a
policy decision that someone could later relax. There are 14 views, all prefixed
`ai_`, and the prefix is load-bearing (see 4).

**3 · Scope lives inside the view.** Every view selecting something that hangs
off a workflow filters through `ai_scope`, a temp table holding the caller's
visible workflow ids, repopulated per request on a connection that runs one
statement at a time. A subquery against `ai_executions` is still a subquery
against the *filtered* `ai_executions`; a UNION unions two filtered relations.
There is no arrangement of a `SELECT` that gets underneath it.

**4 · The statement guard.** `utils/sqlGuard.js` asks one question: does this
statement name anything other than an `ai_*` view? That is all. It is the
smallest defence, not the largest — if it is ever wrong, the three above still
hold. Only reachable through `run_sql`, which is opt-out via `AI_SQL_TOOL=off`.

### Scope is not grouping

Two independent restrictions that must never be confused, both built in
`dao/shared.js`:

- **Scope** (`utils/scope.js`) — what a caller is *allowed* to see. Derived from
  n8n's own `project_relation`. `global:owner` and `global:admin` are
  unrestricted, because in n8n they already are; scoping them would under-report
  the instance, and the first reading of that is data loss.
- **Grouping** (`utils/grouping.js`) — what they *asked* to see: `workflow`,
  `folder`, `tag`, `project`.

`filterFor({ scope, grouping }, column)` builds both, scope first, so a grouping
filter can only narrow further and never widen. **Call `filterFor`, never
`scopeClause` directly** — four DAO functions once took a `grouping` argument and
called `scopeClause`, silently dropping the filter, and the answers looked
correct.

> **Known sharp edge.** `groupingClause` validates the *shape* of an id, not its
> *existence*. `{ workflow: 'NotARealWorkflow' }` is accepted and produces an
> empty set indistinguishable from a real zero. This is the same failure class as
> the bug that motivated the whole filter, and it is still open.

---

## What the model actually sees

Assembled in `prepare()`, chronological — a reader could follow it in this
order, which is the test:

1. **System prompt** (`ai/prompt.js`) — partly generated: instance facts,
   freshness caveats, the timezone, and which tools exist for this user.
2. **Memories** — up to `AI_MAX_MEMORIES` (40), per user, crossing conversations.
   Framed as shaping **how** the answer reads, never **what** is measured. That
   wording is load-bearing: an earlier version said "what to look at first" and
   the assistant took it as licence to narrow instance-wide questions to one
   folder.
3. **How to read this thread** (`historyBlock`) — sent only when there *is* a
   thread. It says the step notes below are a record and not something anybody
   said, because an unlabelled note is one the model reads back to the user as
   prose.
4. **The thread**, oldest first: every message verbatim, and after each answer a
   `system` note listing the analyses it was built from, with their scope.
5. **Subject note** — which entities *this thread* has already measured, resolved
   back into **names** through the scoped catalogue. See below.
6. **Tag preamble** — what the `@`s in *this* message resolved to.
   **Never persisted**: replaying resolved ids into a later, unrelated question
   is how a tag leaks forward.
7. **The question.**

### The summary is gone, and why

Everything past a recent window used to be folded into a paragraph by a second
model call after each answer (`ai/summarise.js`, deleted). It bounded the prompt
and cost two things.

**The transcript.** A summary is the one part of the context nobody can check —
it is not a message anybody said, and by the time it is wrong the originals are
no longer in the prompt to contradict it.

**The work.** The fold read `role` and `content`. Every record of *which analysis
produced which number* — and `sql_used` is the only place a call's arguments
survive — was dropped on the floor. An assistant that can see what it said and
not what it looked at re-resolves the same workflow name every turn (a wasted
step, observed on every follow-up) or answers instance-wide and labels it with
the workflow's name (fluent, wrong, also observed).

So the thread is sent as the thread. `AI_HISTORY_CHARS` (30,000) bounds it,
spent from the newest end backwards; the cut is pushed back to a **user** message
so the oldest thing kept is a question rather than half an exchange, and the
shortfall is **declared** in the prompt — a context silently cut is one the model
describes as the whole conversation.

Two shapes were rejected for the step notes and both are worth knowing:

- **Appended to the assistant's own message.** A model reading its own turn treats
  every word as something it said out loud, and starts writing
  `get_analytics: kpis · workflow 6v295…` into its prose, to the reader.
- **As `tool` messages.** A `tool` message must answer a `tool_call` on the turn
  above it and carry that call's **result**, which is the one thing not stored.
  The envelope without the payload is malformed on some providers and says "the
  tool returned nothing" on the rest.

The subject note survives all this. It does something the steps cannot: it turns
ids back into *names*. `workflow 6v295G18HhxEYZe9` is not recognisable as the
thing the user has been calling ΑΑΑ_Processor, and a model that cannot connect
the two looks the name up again anyway.

### Titles

`ai/title.js`, once per conversation, from the opening **question and its
answer**. The answer is in the input because the question often has no subject —
"is anything broken?" acquires one only when something answers it — and a title
written from the question alone can only restate it.

Awaited before the turn's terminal frame, and the SSE `conversation` event is
emitted **twice** on that first exchange: once with the id as soon as it is known
(so a reader who navigates can be put back in the right thread), once with the
title. Doing it after `finish` would deliver the title to a stream with no
subscribers.

`title_generated` (migration 025) is the guard. `rename` sets it too: a person
who renames a thread has settled its name, and the pass that lands a second later
must not helpfully improve it back. Every failure falls back to
`conversations.titleFrom` — the old truncation — so the worst case is the
previous behaviour rather than "Untitled".

### Tags are re-resolved, never trusted

`@workflow:<id>` arrives as text and is looked up again through the *scoped*
catalogue. **An id from the client is not authorisation** — it is one more word
to search for. A hand-crafted request naming another project's workflow resolves
to nothing and is reported as unresolved. Categories: `tool`, `execution`,
`workflow`, `folder`, `tag`, `project`, `node`/`node_type`, `error`/`error_group`.
An unknown category is not a tag at all, so `ops@acme.com` passes through
untouched.

`@tool:x` becomes `tool_choice` for one step — it compels, it does not suggest.

---

## Turns outlive requests

`ai/turns.js` owns the turn; the HTTP response is only a subscriber. Losing the
client detaches a subscriber — the answer finishes, is written to history, and
the next page reattaches via `GET /api/ai-chat/turn/:id`.

Cancelling is not disconnecting, and only one of them stops the work: someone
who navigated away still wants the answer; someone who pressed Stop does not.
The old rule that half a sentence never enters the history survives, applied to
cancellation, which was always the case it was written for.

| | Default | Env |
|---|---|---|
| Concurrent turns per user | 3 | `AI_TURNS_PER_USER` |
| Heartbeat | 15s | `AI_TURN_HEARTBEAT_MS` |
| Retention after finish | — | `AI_TURN_KEEP_MS` |

> **Deployment constraint.** `turns.js` is in-process. Two Node processes without
> sticky routing means a reattach can land on a process that has never heard of
> the turn — which is "your answer vanished", exactly the failure this removes.

### The SSE protocol

| Event | Payload |
|---|---|
| `turn` | `{ id }` — first, so the answer is findable from another page |
| `tags` | resolved / rejected chips, before the first step |
| `step` | `{ tool, label, ok }` — the phrase shown while a call runs. **No args** |
| `delta` | `{ text }` |
| `conversation` | `{ id }` |
| `conversation` | again, on the opening exchange only, once the title exists |
| `done` | `{ answer, steps, tags, partial }` — `steps` here **has the args** |
| `failed` / `cancelled` | terminal |

The two step shapes are deliberate and were once conflated, which made a
reattaching client replay a row of `undefined`. **Anything asserting on arguments
must read the terminal frame**, not the live ones — the eval harness does.

---

## Adding to it

### A new analysis

One entry in `ai/tools/analytics.js`:

```js
my_metric: {
    run: (o) => someDao.getSomething(o),
    window: 'range',            // 'range' | 'resolved' | 'none'
    describe: 'What it answers, and the mistake a reader would otherwise make.'
}
```

The `describe` string is the model's only documentation — it is generated into
the tool schema. Write it as the misunderstanding it prevents, not as a label.
The best ones in that file say what the number is *not*: concurrency is not
volume, silence is not an error, a retry-aware rate is not the raw one.

`window` decides the envelope `execute.js` builds. `resolved` gets a validated
window with per-metric defaults; `range` gets raw dates plus a filters bag;
`none` gets scope and grouping only.

**Check your DAO honours `grouping`.** If it takes the argument and calls
`scopeClause`, the filter is silently dropped and the answer looks right.

### A new drill-down

`ai/tools/drilldown.js`, keyed by `kind`, taking an `id`. The rule for belonging
there rather than in `analytics.js` is stated at the top of the file: *the input
is not a workflow id*. A trace wants an execution id; a group wants a
fingerprint.

> **Known sharp edge.** `workflow_failure_history` no longer satisfies that rule —
> its input *is* a workflow id, and `get_analytics` grew a `workflow` filter after
> it was written. The model reaches for `get_analytics(metric: …)` and spends a
> recovered step every time. It belongs in `METRICS`; the note is in the file.

### A new tool

`ai/tools/index.js` for the schema, a `case` in `ai/execute.js` for the work.
Consider whether it belongs — the registry collapsed from 29 tools to 7 by
noticing that 20 of them were the same parameter envelope repeated, and that is
the shape to preserve.

---

## Configuration

### The key and the model are settings, not variables

Both used to be environment variables read once at boot. They are written from
**Settings → Integrations** now (`dao/aiConfigDao`), because the dashboard is
installed next to an n8n instance by the person who runs that instance, and
asking them to edit a file on the host and restart a process in order to try a
different model is the same barrier the documentation integration was moved out
of the environment to remove.

| | Stored in | Read by |
|---|---|---|
| Model | `dashboard_settings.ai_model` — not a secret | `aiConfig.model()`, per turn |
| API key | `dashboard_secrets` (migration 024) | `aiConfig.apiKey()`, per call |

**Why two tables.** `GET /api/settings` returns every row of `dashboard_settings`
to any authenticated page — correct for a timezone, catastrophic for a bearer
credential against somebody's billing account. The key gets its own table, and
the same two-reader rule as `integrationsDao`: `describe()` for pages (configured
or not, the last four characters, which source is in force), `apiKey()` for the
code that spends it. Nothing answering an HTTP request calls the second.

**Precedence is stored → environment → default,** and the environment survives on
purpose: an existing deployment must not lose the assistant on upgrade. What is
in force is reported by `describe()`, so an operator who saves one key while an
old one sits in `.env` is not left guessing which is being billed.

**`config/openai.js` no longer builds its client at require time.** It reads the
key per call and memoises the client against it. A client captured at boot is one
holding the key the operator has just replaced — Settings says connected, every
answer 401s against the old credential, and nothing in the UI is wrong enough to
point at. A missing key raises `NotConfiguredError`, which the controller turns
into a 503 saying to add one rather than a 500 saying the assistant is broken.

**No allowlist of model names.** `gpt-5.4-mini` is recommended and is the default;
`utils/validate.js` checks only that the value is model-shaped. A fixed list would
make every model released after this page shipped unreachable until someone
edited a file, which is the barrier being removed. The two requirements a wrong
choice fails on are in `aiConfigDao.RECOMMENDED_MODEL`, and both fail on the first
question rather than at save time.

| Variable | Default | |
|---|---|---|
| `OPENAI_API_KEY` | — | Fallback only; Settings wins |
| `AI_MODEL` | `gpt-5.4-mini` | Fallback only. Must accept `temperature` **and** do function tools on `/v1/chat/completions`. `gpt-5-mini` fails the first; `gpt-5.6-luna` the second. Logged when it changes |
| `AI_MAX_STEPS` | 6 | |
| `AI_MAX_RESULT_CHARS` | 12000 | |
| `AI_SQL_TOOL` | on | `off` removes `run_sql` and `describe_views` |
| `AI_QUERY_TIMEOUT_MS` | 8000 | |
| `AI_HISTORY_CHARS` | 30000 | The thread's own budget in one prompt |
| `AI_HISTORY_MESSAGES` | 80 | So a thread of 400 one-word turns is not read out in full to discover it fits |
| `AI_MAX_MEMORIES` | 40 | Per user; a memory is capped at 240 chars |
| `AI_CATALOG_TTL_MS` | 120000 | FTS5 index cache |
| `AI_TURNS_PER_USER` | 3 | |
| `N8N_DOCS_MCP_URL` | kapa | Only if pointing elsewhere |

The documentation integration stores its credential **per user**
(`integration_credentials`, migration 021) with deliberately no fallback: the
credential is issued against the approving person's own account, so a shared one
would attribute every question to one individual.

---

## Testing

**`npm run check`** — lint plus 184 unit and integration tests, free and offline.
The AI paths are covered by stubbing `src/config/openai` through `require.cache`
and re-requiring the controller: SSE framing, event ordering and abort behaviour
are all tested without a network call or a key.

**`node test/eval/run.js`** — 26 scripted conversations against a *running*
dashboard, scoring each turn on tool usage, statistics, context and coherence.
It spends real model calls, so it is a command someone runs, never something the
suite runs for them. `--dry` prints what would be sent without sending it;
`--clean` removes the conversations earlier runs left behind;
`node test/eval/summarise.js a.json b.json` compares two runs per scenario.

Three of the four dimensions are decided from facts rather than from a judge:
tool calls are recorded with their arguments, figures are compared against the
same DAOs, and a scoped answer that names other workflows has demonstrably lost
the thread. See `test/eval/scenarios.js` — every scenario there is a failure that
was observed on real data, and the negative ones (an instance-wide question that
must *not* be scoped; a thread that must be *allowed* to change subject) are what
stop a fix from overshooting.
