# Backend

*The Node.js/Express layer: how code is organized, the one rule the DAO layer
exists to enforce, and how to add a new endpoint without breaking it.*

For the request lifecycle and the ETL, see [../architecture](../architecture/README.md).
For the schema these DAOs query, see [../database](../database/README.md). For the AI
assistant's own layer on top of this — which follows the same DAO
convention, from the other direction — see [../ai/developers.md](../ai/developers.md).

---

## The layers

```
src/routes/        HTTP path → middleware chain → controller function
src/controllers/   Parses the request, calls a DAO, shapes the response
src/dao/           One place per domain that runs SQL
src/config/        Connections, schema, the ETL, cross-cutting engines
src/middlewares/   auth, scope, grouping, rate limiting, request logging
src/utils/         Pure helpers shared across the above
```

| Path | Owns |
|---|---|
| `src/routes/authRoutes.js` | `/api/login` |
| `src/routes/metricsRoutes.js` | Dashboard, ROI, insights, alerts — one file, several controllers, because they share one middleware chain |
| `src/routes/aiRoutes.js` | The assistant |
| `src/routes/integrationsRoutes.js` | OAuth callback (public) + the assistant's key/docs settings (private) |
| `src/controllers/metricsController.js` | KPIs, executions, ROI, error intelligence |
| `src/controllers/insightsController.js` | Trigger types, queue lag, reliability, storage, silent workflows, dependencies, deploys |
| `src/controllers/alertsController.js` | Rules, channels, events |
| `src/controllers/authController.js` | Login |
| `src/controllers/integrationsController.js` | OpenAI key/model, docs OAuth |
| `src/controllers/aiController.js` | The chat surface — see [../ai/developers.md](../ai/developers.md) |
| `src/dao/shared.js` | The pieces every DAO is built from — read this one first |
| `src/dao/metricsDao.js`, `insightsDao.js`, `errorIntelligenceDao.js`, `alertsDao.js`, `alertEngineDao.js`, `queueLagDao.js` | One SQL surface per domain |
| `src/dao/settingsDao.js`, `aiConfigDao.js`, `integrationsDao.js`, `userDao.js`, `conversationsDao.js`, `syncDao.js` | Settings, secrets, external credentials, the local user mirror, chat, and the ETL's own backlog math |

See [../api](../api/README.md) for what every route actually needs, and
[../frontend](../frontend/README.md) for how a page calls into this layer.

---

## Why a DAO layer, and the line that keeps it one

Until this layer existed, the SQL lived inside the Express handlers — over a
hundred `SELECT`s spread across two controller files, each one welded to a
`req` it read parameters from and a `res` it answered on. That was fine while
HTTP was the only caller. It stopped being fine the moment a second one
appeared: the AI assistant. The alternative would have been writing every
analysis a second time for the model to call, which is the exact fault this
layer exists to remove — two places defining the same thing, drifting apart
on the first change nobody remembers to apply twice.

So: **one place runs the SQL.** A controller parses HTTP and hands down
domain values. The assistant hands down the same domain values, through its
own tool-calling layer. Neither owns the query.

**A DAO never sees `req`.** It takes validated domain values — an ISO
window, a mode string, a scope object — and returns data. HTTP concerns (a
bad date string, a 400) stay in the controller. The moment a DAO reads
`req.query`, it has become a second controller, and this whole layer has
bought nothing.

---

## Scope is a required argument, not an implicit lookup

In the code this layer replaced, scope arrived by reaching into `req` inside
the query itself. That's exactly backwards for something this consequential:
a forgotten scope isn't a bug that shows up as a broken page, it's one user
reading another project's data, and it looks like a working feature the
whole time.

So `filterFor({ scope, grouping }, column)` in `src/dao/shared.js` takes
scope as a **named, required** argument and throws if it's missing:

```js
if (scope === undefined) {
    throw new Error(
        'A DAO filter needs an explicit scope (null for an unrestricted caller). ' +
        'Defaulting it would turn a missed argument into a data leak.'
    );
}
```

`null` means *unrestricted* and has to be passed explicitly — there's no
default that means anything, on purpose.

### Scope vs. grouping — two different restrictions

- **Scope** (`utils/scope.js`) — what a caller is *allowed* to see, derived
  from n8n's own project membership. `global:owner`/`global:admin` are
  unrestricted, because scoping them would under-report the instance, and
  that reads as data loss.
- **Grouping** (`utils/grouping.js`) — what they *asked* to see: one
  workflow, folder, tag, or project.

`filterFor` builds both — scope first — so a grouping filter can only narrow
further, never widen past what scope already allows. **Call `filterFor`,
never `scopeClause` directly.** Four DAO functions once took a `grouping`
argument and called `scopeClause` on its own, silently dropping the filter —
the query ran, returned a plausible number, and it was simply the wrong
number.

### An id that names nothing is refused, not answered as zero

`groupingClause` validates the *shape* of an id — it's a synchronous,
pure SQL-fragment builder and has no way to check whether the id actually
exists. So existence is checked at the edges instead, in
`assertGroupingExists` (`src/dao/shared.js`), reached two ways: the
`verifyGrouping` middleware for HTTP, and directly before any `get_analytics`
dispatch in the AI pipeline.

```js
throw daoError(400,
    `No ${name} with id "${value}" exists in this dashboard's data. ` +
    'It may have been deleted, or the id may be wrong — nothing was measured, ' +
    'rather than measured as zero.');
```

`{ workflow: 'NotARealWorkflow' }` used to produce an empty result set that
was indistinguishable from a real, honest zero — the same failure shape as
the bug that motivated building this filter in the first place. It checks
**existence, not visibility and not contents**: a folder that exists and is
simply empty still answers zero, because making *that* an error repeats the
same mistake pointed the other way, and answering differently for "doesn't
exist" versus "exists but isn't yours" would turn the check into a way to
enumerate another project's ids.

---

## Adding a new endpoint

1. **Write the query in a DAO**, not the controller. Take `scope` and
   `grouping` as explicit arguments if the data hangs off a workflow; run it
   through `filterFor`.
2. **Write the controller.** Parse and validate the HTTP-specific bits (query
   params, body shape) here — a bad date range is the client's mistake and
   gets a 400 here, not a thrown error from inside the DAO.
3. **Register the route** in the right `src/routes/*.js` file, inheriting
   whatever middleware chain that router already applies
   (`authenticateToken` → `resolveScope` → `verifyGrouping` as needed →
   `requireElevatedRole` if it's an owner/admin action).
4. **Add it to [../api](../api/README.md).**
5. If it's something the AI assistant should be able to call too, see
   [../ai/developers.md](../ai/developers.md#adding-to-it) — a new analysis
   there is one entry, reusing the same DAO function.

**Check your DAO actually honours `grouping`.** A function that accepts the
argument and forwards only `scope` to `scopeClause` compiles, runs, and
returns a wrong answer that looks exactly like a right one.

---

## Middlewares

| File | Applies |
|---|---|
| `middlewares/auth.js` | `authenticateToken` (JWT check), `resolveScope` (attaches `req.scope`), `requireElevatedRole` (owner/admin gate, fails open on n8n 1.x — see [../security](../security/README.md)) |
| `middlewares/grouping.js` | `verifyGrouping` — 400s a request whose `?workflow=`/`?folder=`/`?tag=`/`?project=` names nothing |
| `middlewares/rateLimiter.js`, `sqliteRateStore.js` | The rate limiters listed in [../api](../api/README.md), backed by a table in the replica so a restart or a second instance never resets an attacker's allowance |
| `middlewares/requestLog.js` | One structured line per `/api` request — see [../operations](../operations/README.md#logs) |

---

## Testing

```bash
npm run lint     # eslint
npm test         # node --test: unit + integration
npm run check    # both — the gate CI applies before deploying
```

The integration suite boots the real server against a temporary SQLite file
and calls every endpoint. It needs no PostgreSQL and no n8n instance,
deliberately — a test that can't run in CI doesn't run at all. The AI paths
are covered by stubbing `src/config/openai` through `require.cache` and
re-requiring the controller, so SSE framing, event ordering, and abort
behaviour are all tested without a network call or a real key.
