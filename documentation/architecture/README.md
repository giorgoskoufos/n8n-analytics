# Architecture

*How the pieces fit together: the request lifecycle, the ETL pipeline, and the
decisions that only make sense once you've seen a production incident they
were written to prevent.*

For the code layout and MVC conventions, see [../backend](../backend/README.md). For the
schema itself, see [../database](../database/README.md). For the AI assistant
specifically, see [../ai](../ai/README.md) — it has its own request lifecycle, three
levels deep, and gets its own pair of documents.

---

## The shape of it

```
n8n PostgreSQL ──ETL, every 5 min──▶ dashboard.sqlite ──▶ Express API ──▶ Browser
  (read-only)         │                    ▲                                 │
                       │                    └── AI tools + ai_* views ◀──────┘
                  4 read paths:
                  ETL sync · login · execution trace fetch · node profiling
```

Two databases, and they are not peers. PostgreSQL is n8n's — this project
never writes to it, and touches it in exactly four places (below). SQLite is
this dashboard's own file, and it is the *only* thing every page, every chart,
and the AI assistant actually read from. That single fact is why a hard
question asked in chat cannot slow down your automations: it never reaches
the production database at all.

### The four reads against Postgres

1. **The ETL sync**, every `SYNC_INTERVAL_MINUTES`.
2. **Login** — a `bcrypt` comparison against n8n's own `user` table.
3. **On-demand trace fetch** — one row from `execution_data`, only when
   someone clicks *Inspect* on a specific failed execution.
4. **Node profiling** — a handful of `execution_data` rows per sync cycle, to
   work out which node in a workflow is slow.

Everything else — every dashboard page, every insights panel, every AI
answer — is served from the SQLite replica.

---

## Request lifecycle

`server.js` builds one Express app and mounts, in order:

1. **Helmet**, with a hand-written CSP rather than the defaults — `script-src
   'self'` only (every third-party script is vendored, nothing loads from a
   CDN), `script-src-attr 'none'` (inline `onclick=` fails loudly instead of
   silently reopening the hole it closes), and `img-src` allowing exactly one
   external origin (`docs.n8n.io`, because the documentation tool's answers
   embed n8n's own screenshots).
2. **`express.static('public')`**, resolved against the file's own directory
   rather than the process's working directory — starting the server from the
   wrong folder used to serve nothing at all, and looked like a broken
   frontend rather than a wrong start command.
3. **`express.json({ limit: '100kb' })`**.
4. **`requestLog`**, mounted on `/api` only — static assets are noise in a
   request log; every API call is worth a line. It has to be mounted *before*
   the routers so its response hooks attach before a handler can answer.
5. **The OAuth callback** (`integrationsPublicRoutes`), ahead of every router
   that authenticates blanket-style — a browser returning from an n8n-docs
   authorization screen has no bearer token to present.
6. **The routers** — `authRoutes`, `metricsRoutes`, `aiRoutes`,
   `integrationsRoutes` — each internally chaining `authenticateToken` →
   `resolveScope` → (sometimes) `verifyGrouping` → `requireElevatedRole` →
   the controller. See [../api](../api/README.md) for what each endpoint actually needs.
7. **Three health probes**, deliberately three and not one (next section).
8. **The error handler**, last in the chain — Express 5 forwards a rejected
   async handler here instead of leaving the request hanging or answering with
   its own HTML page containing a stack trace. Malformed JSON and oversized
   bodies get a clean 400/413; everything else is logged in full and answered
   with a bare `{ error: 'Internal server error' }` — the detail belongs in
   the log, not in the response.

### Why three health endpoints, not one

| Endpoint | Answers | Cost |
|---|---|---|
| `GET /healthz` | Is the process alive? | No I/O at all |
| `GET /readyz` | Can it actually serve? | One cached Postgres `SELECT 1`, TTL 20s, de-duplicated against a stampede of simultaneous probes |
| `GET /api/health/deep` | Diagnostic detail — Postgres status, replica row count, which instance holds the ETL lock | Authenticated, uncached |

The single `/healthz` this replaced ran `SELECT 1` against production n8n on
every call, unauthenticated. An orchestrator probing once a second turned that
into 86,000 queries a day for a liveness check that should never touch the
network at all — and any anonymous caller could burn the connection pool for
free. Splitting liveness from readiness from diagnostics is what makes each
one cheap enough to actually call as often as it needs to be called.

---

## The ETL pipeline

One pass is thirteen numbered stages, logged as `[n/13]` so a sync in progress
is distinguishable from one that finished quietly, and a stage with nothing to
do prints nothing at all — which is why the numbers in a real log skip around:

| # | Stage | Does |
|---|---|---|
| 1 | `workflows` | Mirrors `workflow_entity` |
| 2 | `authorization` | Re-mirrors projects and project memberships, wholesale |
| 3 | `statistics` | Per-workflow execution counters |
| 4 | `organisation` | Folders, tags, workflow↔tag links, `workflow_history` versions |
| 5 | `executions` | Mirrors `execution_entity`, batched |
| 6 | `volume` | Rolls executions into time buckets for the timeline charts |
| 7 | `analytics` | Drains the error-extraction queue — parses failed executions' payloads |
| 8 | `reclassify` | Re-runs the error classifier over stored rows when its rules changed |
| 9 | `retention` | Clears `input_data`/`error_stack` past their retention window |
| 10 | `backfill` | Fills newly-mirrored columns on old rows, oldest first, time-boxed |
| 11 | `fingerprints` | Groups errors by what actually broke, not by message text |
| 12 | `profiling` | Node-level timing, a few workflows per pass |
| 13 | `done` | Reports whether a backlog remains |

The position comes from a fixed list (`PASS_STEPS` in `src/config/syncJob.js`),
not a running counter — so `[9/13]` names the same stage on every single run,
forever, and a stage that finds nothing to do doesn't renumber the ones after
it. A test asserts every `step()` call site has an entry in that list, because
the one way this numbering rots is someone adding a stage and forgetting to
register it.

**Membership is re-mirrored wholesale, not incrementally, on purpose.**
Removing someone from an n8n project is expressed by their row *disappearing*
— a sync that only ever inserted and updated could never observe a
disappearance, and a revoked user would keep their dashboard access forever.

### Why a first sync takes more than one pass

Five of the thirteen stages are deliberately bounded — executions by a row
limit, the error queue by its chunk size, three backfills by a time budget
each — so a single cycle can never hold the write gate for minutes on a large
instance. Correct, and it has a consequence: a brand-new instance is only
*partly* populated after its first cycle.

That used to be invisible. The pages showed plausible, incomplete numbers, and
the only remedy anyone found was pressing "Sync now" repeatedly. Two things
fixed it, both in `server.js`'s `runSyncPass()`:

- **A cycle that ends with work outstanding schedules the next one in
  seconds** (`SYNC_CATCHUP_DELAY_MS`, default 15s) instead of waiting out the
  full interval — so the replica fills in minutes, not in hours of five-minute
  naps. `MAX_CATCHUP_PASSES` (default 240) is a backstop, not a policy: the
  backlog should shrink every pass, and hitting the cap means something is
  reporting work it isn't completing, so the pass falls back to the ordinary
  cron interval and says so in the log.
- **The backlog is a number the UI shows.** A first-run sheet with a
  percentage while the pages are still empty, then a `Catching up · 43%` line
  in the sidebar afterward — which outranks "Synced 12s ago", because
  mid-catch-up the pipeline is running exactly on schedule while every total
  on every page is still a floor, not the answer.

### Two schedules that deliberately run beside the ETL, not inside it

- **Error fingerprinting** reads and writes only the replica, no Postgres —
  so it runs on its own timer and isn't cancelled by the exact moment Postgres
  becomes unreachable, which is also the moment someone is most likely to be
  staring at the error history the replica already has.
- **The alert pass** runs `ALERT_DELAY_MS` (default 30s) *after* each sync
  tick, not alongside it, so it judges data the cycle has already committed
  rather than racing it. It also refuses to run at all when the replica is
  too stale to trust — see [../security](../security/README.md) and
  [../operations](../operations/README.md) for what that protects against.

---

## Single-writer election

Two processes running the ETL against one SQLite file will corrupt it —
*quietly*. During development here, `PRAGMA integrity_check` kept answering
`ok` on a replica that had silently lost 86% of its rows to exactly this; the
damage was only visible by comparing row counts by hand.

`src/config/instanceLock.js` fixes it with a lock row stored **inside the
replica itself**, not a lock file and not orchestrator config:

- Every instance heartbeats an `UPDATE … WHERE id = 1 AND (owner_id IS NULL OR
  owner_id = ? OR heartbeat_at < ?)` at `TTL_MS / 4`. SQLite serializes
  writers, so exactly one `UPDATE` can ever report a changed row — a
  read-then-write race is structurally impossible here, there is no read.
- The winner runs the ETL. Every other instance serves the dashboard normally
  and simply never writes; `/api/health/deep` reports its role as `reader`.
- A clean shutdown hands the lock back immediately. A hard kill (`SIGKILL`)
  cannot release anything, so the lock expires after `ETL_LOCK_TTL_MS`
  (default 60s) and another instance takes over on its own — no restart, no
  operator action.

The lock protects the ETL specifically, not the boot: a stale lock refusing
*startup* would take the whole dashboard down over a crashed container,
trading a data-integrity risk for an availability one that is strictly worse.
The worst case with this design is stale numbers on a site that still works.

This is also why running several instances behind a load balancer for read
throughput already works today, unconfigured: one syncs, the rest serve.

---

## Graceful shutdown

`docker stop` sends `SIGTERM`, waits out the orchestrator's grace period, then
`SIGKILL`s. Handling only `SIGINT` — as this app used to — means a normal
`docker stop` was a hard kill every time, observed in production as containers
exiting `137` mid-write against a replica holding history n8n has already
pruned and cannot supply again.

`shutdown()` in `server.js` now runs, under a hard deadline
(`SHUTDOWN_TIMEOUT_MS`, default 8s — kept under Docker's default 10s grace
period on purpose):

1. Stop scheduling new work (cron tasks, the catch-up chain, the fingerprint
   and alert timers) — nothing should start while draining.
2. Stop accepting new connections; in-flight requests keep their sockets.
3. Wait for the ETL to reach idle — the step that actually protects the
   replica; everything else here is tidiness by comparison.
4. Release the instance lock, so a replacement starts syncing immediately
   instead of waiting out the TTL.
5. Checkpoint the WAL and close the replica.
6. Drop the Postgres pool — bounded to 1.5s, since this connection is
   read-only and abandoning it costs nothing, whereas blocking on it could
   turn a successful shutdown into a forced exit over the very database that's
   causing the outage.

Every step has its own timeout and swallows its own failure, so one stuck step
can't consume the whole shutdown budget. A hard backstop `setTimeout` forces
`process.exit(1)` at the deadline regardless, because a shutdown routine that
can hang is worse than the crash it exists to soften.

`unhandledRejection` and `uncaughtException` route through the same drain
rather than crashing bare — the crash itself is intentional (masking either
would hide a real bug), but it still deserves a clean database close on the
way down.

---

## Where things live

| Path | Owns |
|---|---|
| `server.js` | Boot, middleware order, cron scheduling, health probes, shutdown |
| `src/config/db.js` | The Postgres pool (n8n's database) |
| `src/config/localDb.js` | The SQLite replica: connection, pragmas, migration runner, batch helpers |
| `src/config/schema.js` | The schema as data — every migration |
| `src/config/syncJob.js` | The ETL, all thirteen stages |
| `src/config/instanceLock.js` | The single-writer election described above |
| `src/config/alertEngine.js` | The alert pass |
| `src/config/errorParser.js` | Error classification rules — pure, no I/O |
| `src/routes/`, `src/controllers/`, `src/dao/` | See [../backend](../backend/README.md) |
| `src/ai/` | The assistant's own pipeline — see [../ai](../ai/README.md) |
| `public/` | The frontend — see [../frontend](../frontend/README.md) |

For everything below the HTTP layer — the DAO convention, scope vs. grouping,
how a new endpoint is supposed to be built — see [../backend](../backend/README.md).
