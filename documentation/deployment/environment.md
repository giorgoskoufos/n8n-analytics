# Environment variable reference

Every environment variable this application reads. **You need six of them to
start** — everything below the first section is a tuning knob with a working
default, and most deployments never touch any of them.

This file exists because `.env.example` used to be 321 lines for eight
settings. The reasoning was worth keeping; making somebody read it before they
can run `cp .env.example .env` was not.

> [!NOTE]
> A variable's presence here does not make it a supported interface. The
> **Internal** section at the bottom lists the ones that may change without a
> major version bump. Build a deployment on those at your own risk.

---

## Required

| Variable | Notes |
|---|---|
| `DASHBOARD_JWT_SECRET` | Signs dashboard session tokens. **Minimum 32 characters — the server refuses to boot below that.** Generate one with `openssl rand -base64 48`. |
| `DASHBOARD_DB_HOST` | Your n8n PostgreSQL. If n8n runs in Docker on this host, this is the *service name* of its Postgres container, not `127.0.0.1` — see [Connecting to a PostgreSQL that runs in Docker](README.md#connecting-to-a-postgresql-that-runs-in-docker). |
| `DASHBOARD_DB_PORT` | Usually `5432`. |
| `DASHBOARD_DB_NAME` | The n8n database. |
| `DASHBOARD_DB_USER` | **Read-only credentials are enough**, and are what you should use. |
| `DASHBOARD_DB_PASS` | |

`DASHBOARD_DATABASE_URL=postgres://user:pass@host:port/db?sslmode=disable` is an
alternative to the five `DASHBOARD_DB_*` settings.

## Commonly set

| Variable | Default | Notes |
|---|---|---|
| `DASHBOARD_PORT` | `3000` | |
| `DASHBOARD_DB_PATH` | `./dashboard.sqlite` | Where the local analytics replica lives. **In Docker this MUST point inside a mounted volume**, otherwise every redeploy destroys your execution history. The image already sets it to `/data/dashboard.sqlite`. |
| `SYNC_INTERVAL_MINUTES` | `5` | Background ETL frequency. |
| `N8N_EDITOR_BASE_URL` | unset | Makes "open in n8n" deep links work, e.g. `https://n8n.example.com`. A link is omitted rather than rendered broken when this is unset. |

---

## AI assistant

**Both of these are optional.** Settings → Integrations → "Assistant model & API
key" writes them into the dashboard's own database, which is the intended
route: it needs no file on the host and no restart, and trying a different model
stops being a deployment.

What is set here is a **fallback**, used only while nothing has been saved in
Settings — so an existing deployment keeps working across an upgrade, and a
fresh one can still be configured entirely from the environment if that is how
you prefer to run things. A value saved in Settings always wins, and the
settings page says which of the two is in force.

| Variable | Default | Notes |
|---|---|---|
| `OPENAI_API_KEY` | unset | Fallback key. |
| `AI_MODEL` | `gpt-5.4-mini` | Anything dropped in here has to accept `temperature` and do function tools on `/v1/chat/completions` — two things newer models increasingly do not: `gpt-5-mini` allows only the default temperature, and `gpt-5.6-luna` refuses function tools on this endpoint entirely. Smoke-test before switching. |
| `AI_SQL_TOOL` | on | Set to `off` to remove the assistant's ability to write read-only SQL. See [security](../security/README.md). |

### n8n documentation assistant (optional)

Lets the assistant answer "why does this happen" from the official n8n docs,
alongside "what happened" from your own data.

**Nothing goes in the environment for this.** The service only supports
`authorization_code`, so it has to be approved in a browser — and the credential
it issues is bound to the approver's own account, which is why it is stored per
user rather than per deployment. Connect it from Settings → Integrations, or on
a headless box:

```bash
node src/scripts/connectDocsMcp.js <your-email>
```

`N8N_DOCS_MCP_URL` only needs setting if you are pointing at something other
than `https://n8n.mcp.kapa.ai`.

---

## ETL sync

| Variable | Default | Notes |
|---|---|---|
| `SYNC_ID_OVERLAP` | `500` | How many execution ids the incremental sync re-reads every cycle. Postgres hands out ids at INSERT but commits land out of order, so a row with a lower id can appear after the sync has already passed it; this window catches it. The rows return through an idempotent upsert, so re-reading them is free of side effects. |
| `SYNC_EXEC_BATCH_LIMIT` | `20000` | The most executions one cycle pulls from Postgres. The incremental fetch used to be unbounded, so a replica a quarter behind meant ~420k rows held in memory and written in ONE transaction that owns the write lock for its whole duration. A cycle that cannot finish now says how many rows are still behind and resumes on the next one. |
| `SYNC_CATCHUP_DELAY_MS` | `15000` | A pass that does not finish tries again after this long instead of waiting for the next scheduled tick. Five stages of a pass are deliberately bounded, so a brand-new replica is not complete after one cycle — and before this existed, the scheduler slept five minutes between bites whether the replica was up to date or 400,000 rows short. |
| `SYNC_CATCHUP_MAX_PASSES` | `240` | A cap on consecutive catch-up passes. A safety net, not a policy: the backlog shrinks every pass so it should never be reached, and the honest reason it exists is that "should never" and "cannot" are different words. |
| `EXECUTION_MISSING_GRACE_MS` | `3600000` | How long an execution may stay absent from Postgres before its status is written off as `unknown`. |

> [!IMPORTANT]
> `SYNC_EXEC_BATCH_LIMIT` has to comfortably exceed `SYNC_ID_OVERLAP`. The fetch
> starts at the overlap, so a limit that cannot get past it spends every batch
> re-reading rows the replica already has: the watermark never moves, the next
> cycle asks the same question, and the sync stalls forever while still
> reporting "N rows read". A value that low is raised automatically and the log
> says so — but the two are a pair, and worth understanding before changing
> either.

### One-time backfill

Backfills the execution columns added in F-01 (trigger mode, queue lag, payload
sizes, the retry graph). It walks the replica in id order, fills in whatever the
n8n Postgres still has, and stops for good once it reaches the end — rows n8n
has already pruned keep NULLs, which is the honest answer.

Time-boxed per cycle and resumable to the row, so it catches up over a few syncs
instead of stalling one of them. On a 500,000-row replica the whole pass took
about 35 seconds across two cycles.

| Variable | Default | Notes |
|---|---|---|
| `BACKFILL_CHUNK` | `2000` | Rows per pass. |
| `BACKFILL_BUDGET_MS` | `20000` | How long one sync may spend catching up. |

---

## Error analytics and retention

Deep error analytics run from a queue, so a failed extraction is retried rather
than lost. None of these normally need changing.

| Variable | Default | Notes |
|---|---|---|
| `ERROR_BATCH_LIMIT` | `500` | Max queue entries drained per sync cycle. |
| `ERROR_CHUNK_SIZE` | `50` | Execution ids per payload query. |
| `MAX_ERROR_PAYLOAD_BYTES` | `5242880` | Traces larger than this are skipped, not loaded. |
| `MAX_ANALYTICS_ATTEMPTS` | `5` | Retries before an execution is parked as failed. |

### Retention

Retention applies to the two heavy columns of the error analytics table. **The
error row itself is never deleted** — every count, category and chart keeps
working. Only the raw evidence behind old rows is cleared. `0` means keep
forever.

| Variable | Default | Notes |
|---|---|---|
| `ERROR_DETAIL_RETENTION_DAYS` | `30` | `input_data` is the payload that entered the failing node: real data from your workflows, and the single largest thing in the replica. Nothing in the dashboard reads it, so it is aged out by default. |
| `ERROR_STACK_RETENTION_DAYS` | `0` (forever) | **Think before changing this.** When the error classifier's rules improve, the dashboard re-derives the message and category of every stored error *from the stack*. Clearing it means those rows keep whatever classification they were given at the time and can never be corrected. |

Clearing a column frees pages inside the database file for reuse, so the file
stops growing — it does not shrink. To actually reclaim the space, run
`node src/scripts/optimizeReplica.js --apply` while the app is stopped.

---

## Alerting

Rules and channels are configured in the UI (Alerts page), not here. These are
the knobs that decide how the engine behaves around them.

| Variable | Default | Notes |
|---|---|---|
| `ALERT_MAX_STALENESS_MS` | `1800000` | How stale the replica may be before the alert pass refuses to run. This is the guard that stops a stalled ETL from paging you about every scheduled workflow at once: silence is measured against the newest execution in the replica, so a pipeline that has stopped makes EVERYTHING look dead. "Evaluate now" in the UI overrides it, because then a person is watching. |
| `ALERT_DELAY_MS` | `30000` | How long after each sync tick the alert pass runs. It runs after the ETL rather than beside it so it judges data the cycle has already written instead of racing it. |
| `ALERT_ALLOW_PRIVATE_TARGETS` | `false` | Whether an alert channel may point at a private or loopback address. Set to `true` if your n8n is on the same host or private network as the dashboard — the normal case for the "trigger an n8n workflow" channel. **Link-local (169.254.0.0/16, fe80::/10) stays blocked either way:** that is the cloud metadata endpoint and no alert belongs there. |
| `ALERT_TIMEOUT_MS` | `10000` | How long one delivery attempt may take before it is abandoned. |
| `ALERT_MAX_ATTEMPTS` | `4` | Retries on later passes before the event is left alone. |
| `ALERT_EVENT_HISTORY` | `2000` | How many fired alerts are kept. The table records suppressed and undelivered events too — "why was I not told" is a question it has to be able to answer — so it is pruned rather than kept forever. |

---

## Error fingerprinting

Rows per chunk, and how long one cycle may spend walking. The walk is resumable
to the row, so being interrupted costs nothing but the current chunk. Once it
reaches the end and verifies that nothing is left, it costs one settings read
per cycle.

| Variable | Default |
|---|---|
| `FINGERPRINT_CHUNK` | `2000` |
| `FINGERPRINT_BUDGET_MS` | `10000` |

---

## Business metadata

n8n's `execution_metadata` holds whatever your workflows chose to record, and
that is not always the harmless order id it sounds like — on the reference
instance it contained AI agent replies describing infrastructure.

Keys are always mirrored: they describe *what* a workflow records, not what it
recorded. Values are length-capped, and can be dropped entirely.

| Variable | Default |
|---|---|
| `SYNC_METADATA_VALUES` | `true` |
| `METADATA_VALUE_MAX` | `512` |

---

## Node profiling

"Which node is the bottleneck" cannot be answered from failed executions — the
failing node stops early and the rest never run — so this samples **successful**
ones. It is the only place the dashboard reads execution payloads it was not
already going to read, which is why every dial below is a limit.

| Variable | Default | Notes |
|---|---|---|
| `PROFILE_SAMPLES` | `5` | Executions read per workflow. Small on purpose: node time here is dominated by one node per workflow by a factor of ten or more (21.6 s of a 23.2 s execution, measured), so five samples separate the bottleneck from everything else, and fifty would multiply the bytes for a sharper number nobody needs. |
| `PROFILE_WORKFLOWS_PER_PASS` | `6` | A workflow with no execution newer than its last sample is skipped entirely. |
| `PROFILE_BUDGET_MS` | `15000` | How long one cycle may spend. |
| `PROFILE_INTERVAL_HOURS` | `24` | How old a profile may get before it is rebuilt. |

---

## Analytics tuning

| Variable | Default | Notes |
|---|---|---|
| `CONCURRENCY_LOOKBACK_MS` | `3600000` | How far before the requested window the concurrency sweep looks, to catch executions that were already running when it started. The longest execution ever recorded on the reference instance is 336 seconds, so an hour is two orders of magnitude of margin — and it is what keeps that query an indexed range scan. |
| `SYNC_RUN_HISTORY` | `500` | How many ETL passes are kept in `sync_runs`, which is what the Dashboard Health panel reads. At a five-minute cadence, about 42 hours. The growth figure on that panel can only measure what this retains, and it says so. |
| `API_RATE_LIMIT_PER_MINUTE` | `300` | Requests per minute per user across the API. |

---

## Connection and shutdown

| Variable | Default | Notes |
|---|---|---|
| `DASHBOARD_DB_STATEMENT_TIMEOUT_MS` | `60000` | Query timeout against the n8n Postgres. The ETL is a background job — failing fast beats holding a connection open, since it can always try again next cycle. |
| `DASHBOARD_DB_CONNECT_TIMEOUT_MS` | `15000` | Connection timeout. |
| `ETL_LOCK_TTL_MS` | `60000` | How long an ETL lock is honoured without a heartbeat before another instance may take over. Only one instance ever runs the ETL; the rest serve reads. You do not need to set this — see [Running more than one instance](README.md#running-more-than-one-instance). |
| `SHUTDOWN_TIMEOUT_MS` | `8000` | How long a graceful shutdown may take before the process forces its own exit. **Keep it below your orchestrator's stop grace period** (Docker's default is 10s) — if it is longer, the SIGKILL lands first and the replica is never checkpointed. |

---

## Logging and diagnostics

There are two sinks. The console used to be the only place logs went, which
meant choosing between a readable operator view and a complete structured
record.

- **console** — a narrative: is the sync still running, did the process start or
  stop cleanly. Only `LOG_CONSOLE_COMPONENTS` (plus any warning or error, from
  anywhere) reaches it.
- **file** — everything, unconditionally, one JSON object per line. Meant to be
  mounted by something else later (Promtail, Loki, a support bundle). It lands
  beside the SQLite replica by default, so the volume you already mount for the
  database carries the logs too, with nothing new to provision.

| Variable | Default | Notes |
|---|---|---|
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug`. |
| `LOG_FORMAT` | pretty on a TTY, else `json` | Only affects the **console** — the file sink is always JSON, since nothing reads it a line at a time. |
| `LOG_CONSOLE_COMPONENTS` | `SYNC,SERVER,LOCK` | Components always shown on the console, at every level: the ETL narrating itself, the process narrating its lifecycle, and the lock that decides whether this instance is the one syncing. Every component still reaches the file regardless. Set to `*` to mirror the file onto the console too. |
| `LOG_FILE` | `logs/app.jsonl` beside `DASHBOARD_DB_PATH` | Or `off` to disable it. |
| `LOG_FILE_MAX_BYTES` | `10485760` | Rotation. This file shares a volume with data that cannot be re-synced from n8n, so it must never be the reason that volume fills up. |
| `LOG_FILE_BACKUPS` | `2` | About 30 MB at the ceiling, with the default size. |
| `SLOW_REQUEST_MS` | `2000` | Requests slower than this are logged at `warn`. |
| `SAVE_DEBUG_ERRORS` | `false` | Writes every extracted error payload to disk for troubleshooting. **Leave it off:** the file contains the raw node input, which is real customer data — the one thing this replica otherwise ages out. |
| `DEBUG_ERRORS_PATH` | `./scratch/debug_errors.json` | Only used when the above is on. |

---

## Internal

Read by the code, but **not a supported interface.** They exist for tests and
for development, and they may change or disappear in any release.

| Variable | What it does |
|---|---|
| `SKIP_BOOT_SYNC` | Skips the sync that normally runs at startup. Used by the integration suite, which boots the real server with no n8n instance to reach. |
| `GIT_SHA` | Stamped in by the release build so `/api/version` can report the commit. Set it yourself and you are only lying to your own bug reports. |
| `DOCS_OAUTH_PORT` | Loopback port for the docs-assistant authorization callback. |
| `N8N_DOCS_TIMEOUT_MS` | Timeout for docs-assistant lookups. |
| `AI_MAX_STEPS`, `AI_MAX_RESULT_CHARS`, `AI_QUERY_TIMEOUT_MS`, `AI_MAX_MEMORIES`, `AI_HISTORY_MESSAGES`, `AI_HISTORY_CHARS`, `AI_CATALOG_TTL_MS`, `AI_TURNS_MAX`, `AI_TURNS_PER_USER`, `AI_TURN_KEEP_MS`, `AI_TURN_HEARTBEAT_MS` | Assistant loop, context and concurrency limits. |
