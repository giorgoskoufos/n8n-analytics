# n8n Analytics Dashboard

> [!NOTE]
> This is a **test project**, free to use and open to the community. We welcome suggestions and contributions to make it better for everyone!

A high-performance analytics dashboard for **self-hosted n8n** instances. It syncs execution metadata out of your n8n PostgreSQL into a local SQLite replica and serves every chart, table, and AI query from that replica — so your production database never carries analytical load.

## 📸 Screenshots

| Main Dashboard | Error Intelligence |
|:---:|:---:|
| ![Main Dashboard](documentation/images/main.png) | ![Error Intelligence](documentation/images/error.png) |

<br>

| ROI Analytics | Mobile Responsiveness |
|:---:|:---:|
| <img src="documentation/images/roi.png" width="800"> | <img src="documentation/images/mobile_main.jpg" height="400"> |

### 🧩 Detailed Widgets

| Execution Volume | Error Hotspots |
|:---:|:---:|
| ![Execution Volume](documentation/images/main_exec_volume_daily.png) | ![Error Hotspots](documentation/images/main_error_hotspots.png) |
| **Execution Logs** | **Slowest Workflows** |
| ![Execution Logs](documentation/images/main_executions_rows.png) | ![Slowest Workflows](documentation/images/main_slowsest_workflows.png) |

---

## 🎯 Who is this for?

Anyone running their own n8n instance who wants long-horizon analytics without migrating to n8n Cloud or buying an enterprise license.

n8n 2.x does ship insights tables in self-hosted installs — `insights_by_period`, `insights_raw` and `insights_metadata` are populated on a plain self-hosted instance (16,758 rows on the one this was built against). What your **license tier** decides is how much of that surfaces in the editor UI; the data is there either way. Separately, n8n prunes execution rows aggressively by default. This dashboard fills both gaps:

- **Long-horizon history.** The local replica keeps rows that n8n has already pruned from PostgreSQL. Once a row is synced, it stays — the archive grows well past your n8n retention window.
- **Zero load on production.** All analytics and AI queries run against the SQLite replica, not your n8n database.
- **Operational depth.** Node-level failure analysis, upstream "brittle path" origins, ROI tracking, and natural-language querying.
- **Your hardware, your data.** Nothing leaves your infrastructure except the AI Assistant's calls to OpenAI, which is optional.

---

> [!IMPORTANT]
> **Hard requirements**
> 1. **Self-hosted n8n only** — the ETL needs direct database access.
> 2. **PostgreSQL only** — n8n must be configured with Postgres. The default n8n SQLite backend is not supported.
> 3. **A persistent volume for the replica** — see [Docker installation](#docker-installation). This is the single most common cause of data loss.
>
> Running more than one instance is *not* a hard requirement to avoid — the app elects a single ETL writer on its own. See [Running more than one instance](#-running-more-than-one-instance).

> [!WARNING]
> **Version compatibility**
> The ETL reads a minimal slice of n8n's schema (`workflow_entity`, `execution_entity`, and `execution_data` on demand — metadata columns only, no workflow definitions). Built and tested against **n8n 2.x on PostgreSQL 17**; n8n 1.x is expected to work but is not actively verified. A major n8n schema change may require a sync-job update, but day-to-day analytics are unaffected because they run off the local replica.

---

## 🚀 Key Features

- **Real-time metrics** — total executions, error counts, average runtimes, period-over-period deltas.
- **Execution timeline** — successes vs. errors over 24h, 48h, 7d, 14d, 30d, or a custom date range, with active-bucket forecasting so the current partial bucket doesn't read as a crash.
- **Error Intelligence** — node-level failure analysis, deduplicated error groups, category breakdown (`rate_limit`, `auth`, `network`, `config`, `data`, `logic`, `upstream`), and the upstream origin nodes that triggered each crash.
- **Trigger-type analysis** — every figure splittable by how the execution was started. A webhook failure and a schedule failure are different problems, and one blended error rate describes neither: on the instance this was built against webhooks fail at 4.0% and schedules at 1.1%, while the dashboard reported 3.9% for everything.
- **Queue lag** — p50/p95/p99 of the wait between an execution being created and starting, over time and per trigger type, with a backpressure signal that fires only when lag climbs while throughput does not. The first metric to move when a queue-mode instance runs short of workers, and no n8n tool measures it.
- **Storage forecast** — which workflows the n8n database's size actually comes from, per run as well as in total, and where it is heading. Detects that n8n is pruning and predicts the plateau instead of extrapolating a straight line to a crisis that will not happen.
- **Retry-aware error rates** — raw and effective side by side, so a failure that succeeded on the second attempt stops being counted as an outage the moment retries are switched on.
- **Error fingerprinting** — failures grouped by what actually went wrong rather than by the text of the message. On the instance this was built against, 14,271 errors collapsed from 1,524 unreadable groups into 98 units of work.
- **Transient vs. structural, measured** — whether a failure recovers is decided by whether the next run of that workflow succeeded, not by which category its wording falls into. Four of six groups here behaved against their label; one marked "transient" recovered 0 times out of 47.
- **Silent death detection** — an active workflow that quietly stopped running raises nothing in n8n. This learns each workflow's own cadence and flags the ones that missed it, measured against the freshness of the data rather than the clock, so a stalled sync cannot make everything look dead.
- **Blast radius** — which workflows share a credential or a node type, and the sub-workflow call graph. One credential here is used by 42 workflows; when it expires that is not one broken automation.
- **Deploy correlation** — `workflowVersionId` joined to `workflow_history`, so error rates can be compared across versions of the same workflow, with the author and timestamp. Git blame for automations, which no n8n tool offers.
- **Node-level execution** — where a workflow's time actually goes, node by node, and how many items cross each edge. One workflow here spends 99.7% of its runtime in a single node, and an AI chat model ran five times to consume 21.6 s of a 23.2 s execution — neither is visible at the workflow level. It also catches nodes that failed inside executions n8n recorded as successful, which no error rate counts.
- **Alerting** — seven rule types (new failure, error rate, silent workflow, queue lag, volume drop, payload spike, database growth), configured in the UI, delivered by webhook, Telegram, or by triggering an n8n workflow. With deduplication and cooldown, and a refusal to fire at all when the replica is too stale to judge.
- **Error lifecycle** — acknowledge, resolve or ignore a fingerprint with a note, and it reopens by itself if the problem comes back. Ignored problems stop alerting but keep being counted.
- **Folders, tags and projects** — every figure filterable by n8n's own structure, with totals rolling up the folder hierarchy.
- **Self-observability** — the dashboard reports on its own pipeline: when it last synced, how long passes take, what failed, what is queued, and how the replica is growing.
- **ROI Analytics** — two tabs on one page: **Overview** totals the time and money
  saved, and **Configure** is where the per-workflow figures behind those totals
  are set. They are together because the question the Overview raises — *why is
  that workflow showing zero?* — is answered by the inputs, and a number nobody
  can see the input to is a number nobody can correct. A **coverage** tile says
  how many workflows are configured at all, so a total from a partly-filled
  instance reads as the floor it is rather than as a measurement.

  The per-run figure is not typed from memory. **Work it out** asks for the job
  the automation replaced — *a person did this 5 times a week and it took 30
  minutes* — and divides a month of that work by how many times n8n actually ran,
  showing every step as you type. Dividing by measured volume is what keeps the
  figure honest when a workflow's traffic changes.
- **Deep-linking** — one click from a failing execution into the n8n workflow editor.
- **AI Analytics Assistant** — natural-language questions answered by calling the dashboard's own analyses ("Which workflow was slowest yesterday?"), so its numbers agree with the pages.
- **Audit extracts** — CSV/JSON exports with execution IDs, error stacks, and metadata.
- **Security defaults** — JWT auth against your existing n8n users, rate limiting, strict CSP, sanitized rendering.

---

## 🏗️ How it works

```
n8n PostgreSQL  ──ETL every 5 min──▶  dashboard.sqlite  ──▶  Express API  ──▶  Browser UI
                                            ▲                                      │
                                            └────────  AI tools + read-only views  ◀────┘
```

The ETL (`node-cron`) copies a narrow set of columns from n8n's `workflow_entity` and `execution_entity` into the local replica, and extracts structured error details from failed executions. Everything the dashboard renders is read from the replica.

PostgreSQL is contacted in exactly four places, every one of them read-only:
1. The ETL sync (every `SYNC_INTERVAL_MINUTES`).
2. Login — `bcrypt` comparison against n8n's `user` table.
3. On-demand raw trace fetch — a single row from `execution_data` when you click **Inspect** on a specific failed execution.
4. Node profiling — a handful of `execution_data` rows per sync cycle, to work out which node in a workflow is slow. Bounded by `PROFILE_*`; see below.

Nothing in the codebase writes to your n8n database.

### Insights

The questions the replica could not answer until it mirrored more than five columns, on one page (`/pages/insights.html`): trigger types, queue lag, reliability, real concurrency, storage growth, silent workflows, organisation, dependencies, deploys, and business metadata.

Each panel states how much of its window it could actually see. The mirrored columns are NULL on every execution n8n had already pruned before the dashboard first synced them, so a chart reaching back past the retention horizon is answered from a shrinking sample — and without saying so it would show traffic collapsing in the past, which is the replica's history rather than the instance's.

### Alerting

Rules are defined in the UI (`/pages/alerts.html`), not in configuration. Each one is the same sentence with different nouns — *a number, over a window, compared with a threshold, on a subject* — and the subject can be the whole instance, one workflow, a folder (children included), or a tag.

| Rule | Fires when |
|---|---|
| `new_fingerprint` | A failure nobody has seen before, judged on when the problem first appeared rather than on this window |
| `error_rate` | A workflow is above X% over the window |
| `silent_death` | An active workflow has been quiet for X times its own usual gap |
| `queue_lag` | The p95 wait before starting is above X ms |
| `volume_drop` | Executions fell below X% of the previous window |
| `payload_spike` | Average payload per run grew X times |
| `db_growth` | Retained execution data passed X GB |

Three things it deliberately does:

- **It goes quiet rather than loud when its own data is stale.** Silence is measured against the newest execution in the replica, so a stalled ETL would make every scheduled workflow look dead. If the replica is more than `ALERT_MAX_STALENESS_MS` behind, the pass does not run at all and the page says so. An alerting system that cries wolf the moment its own pipeline hiccups gets switched off within a week.
- **It records what it suppressed.** "Why was I not told" is a question the event log has to be able to answer, so cooldowns and channel-less rules leave rows too, with the numbers behind the decision.
- **It writes the event before it sends it.** Delivery happens outside the replica's write lock — a slow webhook must not hold up the ETL — and a crash mid-send leaves a durable record the next pass retries rather than an alert nobody hears about.

Channels are webhook, Telegram, or an n8n webhook URL. The last is usually the right answer: the dashboard tells n8n, and n8n decides what to do with its own credentials, which is how email happens here without this project ever learning your SMTP password. Secrets are redacted on read and preserved when you edit a channel without retyping them. Targets on private or loopback addresses are refused unless you set `ALERT_ALLOW_PRIVATE_TARGETS=true`; link-local is always refused.

### Enabling deep historical analytics

n8n prunes execution data frequently by default. To build long-term trends, raise the retention window on your **n8n instance**:

```env
EXECUTIONS_DATA_PRUNE=true
EXECUTIONS_DATA_MAX_AGE=720   # hours; see n8n docs for the unit in your version
```

> [!NOTE]
> Raising n8n's retention grows your **PostgreSQL** database. The dashboard's replica stores only lightweight metadata — no workflow definitions, no execution payloads — so it stays small by comparison. Note also that pruning in n8n never removes rows already synced into the replica, so the archive keeps growing even if you leave n8n's defaults alone.

---

## 🧱 Security & data privacy

### What is synced

| Source | Columns copied |
|---|---|
| `workflow_entity` | `id`, `name`, `active` |
| `execution_entity` | `id`, `workflowId`, `status`, `startedAt`, `stoppedAt` |

The `nodes` column (workflow definitions, credentials references) and the `data` payload of successful executions are **never** copied.

### What the error extractor does store

When an execution fails, the ETL parses its payload and stores a structured record in `execution_error_analytics`: node name and type, error type, error message, error category, timestamp — and also `error_stack`, `metadata`, and `input_data`.

> [!CAUTION]
> **`input_data` and `error_stack` can contain production data.** They hold the item that was being processed when the node threw, which may include customer records, tokens, or anything else flowing through the failing workflow. This is what makes the error modal genuinely useful for debugging — and it means the replica is not free of sensitive data.
>
> Three consequences:
> - Treat `dashboard.sqlite` with the same care as your n8n database.
> - The AI Assistant **cannot** reach these columns. It reads the replica through a separate `OPEN_READONLY` connection on which the only visible relations are a set of `ai_*` views, and those views do not define `input_data`, `error_stack` or `error_message`. A query naming one fails inside SQLite as `no such column`, not in an application check that could be worked around.
> - `input_data` is cleared from rows older than 30 days by default, because nothing in the dashboard reads it. `error_stack` is kept, because the classifier re-derives from it. Both are configurable — see [Operating it](#-operating-it).

### Guarantees that do hold

- **Read-only against n8n.** No `INSERT`/`UPDATE`/`DELETE` path to your n8n database exists anywhere in the code.
- **No SQL mutation locally.** The assistant's connection is opened `OPEN_READONLY`, so a write fails with `SQLITE_READONLY` regardless of what the statement says. A guard also rejects anything that is not a `SELECT`/`WITH` and blocks DML/DDL keywords, but it is the second line, not the first.
- **Air-gapped from production.** AI-generated SQL runs against the local SQLite file. Even a malicious query has no route to your Postgres server.
- **Helmet + strict CSP.** `script-src-attr 'none'`, no `unsafe-inline`, no external `connect-src`. Rendered markdown passes through DOMPurify with a restricted tag allowlist.
- **Scoped reads.** Every analytics query is narrowed to the workflows the caller's n8n projects own, including the endpoints addressed by id — an execution outside your projects answers 404, the same as one that does not exist.
- **No secrets in logs.** The logger redacts credential-shaped keys at any depth before writing.

---

## 🔐 Authentication

The dashboard has no user management of its own — it authenticates directly against your n8n user base.

- **Same credentials.** Log in with the exact email and password you use for n8n.
- **Bcrypt matching.** Your input is compared against the hash in n8n's `user` table. The raw password is never stored or logged.
- **Pass-through identity.** Change your n8n password and it takes effect here immediately.
- **Disabled and MFA-enabled accounts are rejected.** Users with `disabled = true` cannot log in. Users with MFA enabled are blocked with an explanatory message, because the dashboard cannot verify the second factor.

Sessions are JWTs signed with `DASHBOARD_JWT_SECRET`. The server refuses to boot if that secret is shorter than 32 characters.

### Who sees what

Authentication says *whether* you get in. Authorization decides *what you then see*, and it mirrors n8n's own model rather than inventing one: a workflow belongs to a project, a user belongs to a project.

| n8n role | What the dashboard shows |
|---|---|
| `global:owner`, `global:admin` | Everything. These roles can open any workflow in n8n, so scoping them here would report fewer executions than the instance actually ran — which reads as data loss, not as security. |
| Any other role | Only workflows in the projects that user belongs to. Executions, errors, ROI and volume all hang off a workflow id, so all of them narrow together. |

Two consequences worth knowing before you add a second user:

- **Instance-wide settings and forced syncs are owner/admin only.** Both change something for everybody.
- **The AI Assistant is available to every user**, and answers within their own scope. It used to be owner/admin only, because a filter cannot be safely bolted onto a query a model composed — one subquery steps around it. It no longer composes those queries, and the restriction now lives inside the views it reads, where a subquery meets it rather than avoiding it.

Membership is re-mirrored on every sync, wholesale rather than incrementally. That matters: removing someone from a project in n8n is expressed by the row *disappearing*, and a sync that only ever inserts and updates could never observe a disappearance — the revoked user would keep their access here forever.

---

## 🖥️ Stack

**Backend** — Node.js + Express 5, modular MVC:

| Path | Role |
|---|---|
| `src/config/db.js` | PostgreSQL connection pool (n8n source) |
| `src/config/localDb.js` | SQLite replica: connection, pragmas, migration runner, batch helpers |
| `src/config/schema.js` | The schema as data — migrations, indexes, and which n8n columns are mirrored |
| `src/config/syncJob.js` | The ETL and the error classification engine |
| `src/config/instanceLock.js` | Single-writer election for the ETL, stored in the replica itself |
| `src/config/errorParser.js` | Error classification rules — pure, no I/O, unit-tested |
| `src/config/openai.js` | OpenAI client initialization |
| `src/controllers/metricsController.js` | The dashboard, executions, ROI and error intelligence |
| `src/controllers/insightsController.js` | Trigger types, queue lag, reliability, storage forecast |
| `src/middlewares/` | `auth.js` (JWT + scope), `rateLimiter.js`, `sqliteRateStore.js`, `requestLog.js` |
| `src/utils/scope.js` | Which workflows a user may see |
| `src/utils/validate.js` | Input validation shared by the controllers |
| `src/utils/logger.js` | Levelled, redacting, JSON-or-pretty logger |
| `src/routes/` | Endpoint → controller mapping |
| `src/scripts/optimizeReplica.js` | Offline replica maintenance (dry-run by default, `--apply` to commit) |
| `test/` | `node --test` suites — unit, plus an integration run that boots the real server |

**Frontend** — vanilla JS and the standard DOM API, no bundler and no JS build step.

Every third-party asset is served from `public/vendor/`: Chart.js, marked, DOMPurify, Font Awesome and Open Sans. Nothing is fetched from a CDN, so the dashboard renders with no external network access and no origin other than your own can supply script to a page holding an auth token. To upgrade one of them, bump it in `package.json` and re-run:

```bash
npm install
node src/scripts/vendorAssets.js   # copies node_modules → public/vendor
```

The copies are committed on purpose — the Docker build installs dependencies before the source is copied in, so they have to already be in the image.

Tailwind CSS v4 **is** compiled — run `npm run build:css` after editing `public/css/input.css` (or `npm run watch:css` while developing).

**Schema** — applied by an ordered set of migrations recorded in `schema_migrations`, each in its own transaction. They are idempotent, so an existing replica upgrades in place, and a migration that fails stops the process rather than leaving the schema in a state nobody has described. On boot the app also enables WAL journaling, sets a 5s busy timeout, and creates the indexes covering the dashboard's access patterns.

**The server does not accept connections until the migrations have finished.** A container that has not bound its port is not ready, which is exactly what an orchestrator should see.

**What is mirrored** — n8n's `execution_entity` has nineteen columns. The replica takes fourteen of them: the four this dashboard started with, plus trigger mode, creation time, wait-until, finished, the two retry columns, the JSON and binary payload sizes, and the workflow version that ran. From `workflow_entity` it also takes archived state, parent folder, created/updated, trigger count and description. Which columns are read is decided at runtime from `information_schema`, so an instance a version or two behind gets fewer columns rather than a failing ETL.

Two are left out on purpose. `deletedAt` would always be NULL here, because the fetch already filters soft-deleted rows out — a column that can only ever hold one value reads like an answer. `storedAt`, `deduplicationKey`, `tracingContext` and `usedPrivateCredentials` have no consumer; mirroring a column costs a write on every row forever, so each has to earn it.

**Catching up** — a replica that predates those columns fills them in from Postgres over the next few sync cycles, oldest first, time-boxed so no single cycle stalls. Executions n8n has already pruned keep NULLs, which is the truthful answer rather than a guess. On the 500,000-row replica this was built against, 98,000 rows still existed upstream and the whole pass took about 35 seconds; the remaining 405,000 are history only this database still has.

**Two archives, not one** — the replica deliberately outlives n8n's pruning, so "what this database knows" and "what n8n is still holding" are different sets, and they drift further apart every day. That matters to exactly one thing: the storage forecast, whose whole subject is the size of the *source*. Each ETL cycle therefore records the oldest execution id Postgres still has (`source_oldest_execution_id`, one indexed `MIN(id)`), and the forecast is bounded by it. Without that bound the panel would keep counting payload sizes for executions n8n deleted weeks ago, and report a store growing without limit — the exact false alarm it exists to prevent.

---

## 🤖 AI Chat Assistant

> **In depth:** [documentation/ai/how-it-works.md](documentation/ai/how-it-works.md) —
> what you can ask it, what it refuses and why, and how to check an answer. No code.
> [documentation/ai/developers.md](documentation/ai/developers.md) — the request
> lifecycle, the four safety mechanisms, and how to add an analysis.

The assistant answers by calling the dashboard's own analyses rather than by writing
queries. Ask "why did Call Center fail yesterday" and it looks up what *Call Center* is,
reads the error intelligence for that folder, and drills into the group that stands out —
the same three steps a person would take.

**What it can reach**

| | |
|---|---|
| **20 analyses** | The same functions the pages call, so the chat and the charts cannot disagree. |
| **A catalogue** | Every workflow, folder, tag, project, node type and error group, searchable by name — this is how "the Call Center errors" resolves to a folder rather than being guessed at. |
| **Drill-downs** | One execution's timing, one workflow's failures, one error group's occurrences. |
| **A query escape hatch** | For questions no analysis covers. Read-only, restricted to the `ai_*` views, forced `LIMIT`, and a timeout. |
| **The n8n documentation** | Optional, and connected per person from **Settings > Integrations**. The tool is not offered to anyone who has not connected it. |

**What it cannot reach, by construction**

Execution payloads, raw error messages, stack traces, credentials, business-metadata values,
and other users' conversations. These are not filtered out by a check in the application —
they are absent from the views the assistant's connection can see, so SQLite refuses them.

**Three independent mechanisms**

| Threat | Mechanism |
|---|---|
| Writing to the replica | `OPEN_READONLY` — enforced by SQLite, below any SQL |
| Reading customer data | The `ai_*` views simply have no such column |
| Reading another project's data | A membership test **inside** each view, so a subquery or `UNION` cannot step around it |

Every answer carries a collapsed *How this was worked out* trail listing the analyses it used.
The generated SQL is no longer displayed, because it is no longer the reasoning.

**Connecting the documentation service**

There is no token to paste anywhere. The service supports only
`authorization_code` and `refresh_token` — no machine grant — so it has to be
approved in a browser once. Settings > Integrations does that; on a box with no
browser, `node src/scripts/connectDocsMcp.js <your-email>` does the same thing
from a terminal.

The connection is **per person**, and that is about accountability rather than
privacy: the documentation is public, but the credential is issued against the
approver's own account at the service, so one shared connection would attribute
every question to one person and land any misuse on them. Each user connects
their own, and nobody falls back to anybody else's.

Requires an OpenAI API key, set in **Settings > Integrations**; the rest of the
dashboard works without one. `gpt-5.4-mini` is the recommended model and the
default — a replacement has to accept `temperature` *and* support function tools
on `/v1/chat/completions`, and several recent models fail one or the other on
the first question rather than at save time.

The key and the model can also come from `OPENAI_API_KEY` and `AI_MODEL` in the
environment, which is what they used to require. That path is a fallback now:
anything saved in Settings wins, and the page says which of the two is answering.

---

## 🛠️ Installation

### Prerequisites

- **Node.js 20+** (the Docker image uses `node:22-alpine`; Node 18 is end-of-life and no longer receives security patches)
- **PostgreSQL access** to your n8n database — read-only credentials are enough; the dashboard never writes to it
- **OpenAI API key** — only if you want the AI Assistant. Paste it into Settings > Integrations after the first login; no environment variable is needed

### Environment (`.env`)

```env
# --- Server ---
DASHBOARD_PORT=3000
# Minimum 32 characters. The server refuses to boot below that.
# Generate with: openssl rand -base64 48
DASHBOARD_JWT_SECRET='your_secure_random_secret'

# --- Replica location ---
# In Docker this MUST point inside a mounted volume.
# Omit for local development (defaults to ./dashboard.sqlite).
#DASHBOARD_DB_PATH=/data/dashboard.sqlite

# --- n8n PostgreSQL ---
DASHBOARD_DB_USER=postgres
DASHBOARD_DB_HOST=your_db_host
DASHBOARD_DB_NAME=n8n_data
DASHBOARD_DB_PASS=your_password
DASHBOARD_DB_PORT=5432
# Alternative to the five vars above:
#DASHBOARD_DATABASE_URL=postgres://user:pass@host:port/n8n_data?sslmode=disable

# --- n8n editor deep-links ---
N8N_EDITOR_BASE_URL=https://your-n8n-instance.com

# --- AI Assistant (optional) ---
# Both are optional and both are fallbacks: Settings > Integrations writes them
# into the dashboard's database, needs no restart, and takes precedence.
#OPENAI_API_KEY=sk-proj-your-key-here
#AI_MODEL=gpt-5.4-mini            # the default; must do temperature AND function tools

# --- ETL ---
SYNC_INTERVAL_MINUTES=5          # optional, defaults to 5
#SYNC_ID_OVERLAP=500             # ids re-read each cycle, so late commits are not missed
#EXECUTION_MISSING_GRACE_MS=3600000  # before a vanished execution is marked 'unknown'
#SAVE_DEBUG_ERRORS=true          # dumps raw JSON traces to disk for troubleshooting

# --- Multi-instance & shutdown ---
#ETL_LOCK_TTL_MS=60000           # how long an abandoned ETL lock is honoured
#SHUTDOWN_TIMEOUT_MS=8000        # must stay below your orchestrator's stop grace period

# --- Error analytics queue ---
#ERROR_BATCH_LIMIT=500           # max queue entries drained per cycle
#ERROR_CHUNK_SIZE=50             # execution ids per payload query
#MAX_ERROR_PAYLOAD_BYTES=5242880 # traces larger than this are skipped, not loaded
#MAX_ANALYTICS_ATTEMPTS=5        # retries before an execution is parked as failed

# --- Retention --- (see "Operating it": the row is always kept, only the heavy
# columns are cleared. 0 means keep forever.)
#ERROR_DETAIL_RETENTION_DAYS=30  # clears input_data; nothing in the app reads it
#ERROR_STACK_RETENTION_DAYS=0    # keep: reclassification re-derives from it

# --- Alerting --- (rules and channels are configured in the UI, not here)
#ALERT_MAX_STALENESS_MS=1800000  # refuse to judge data older than this
#ALERT_DELAY_MS=30000            # how long after each sync tick the pass runs
#ALERT_ALLOW_PRIVATE_TARGETS=false  # true if your n8n is on the same network
#ALERT_TIMEOUT_MS=10000          # per delivery attempt
#ALERT_MAX_ATTEMPTS=4            # retries before an event is left alone
#ALERT_EVENT_HISTORY=2000        # fired alerts kept

# --- Node profiling (F-12) ---
#PROFILE_SAMPLES=5               # successful executions read per workflow
#PROFILE_WORKFLOWS_PER_PASS=6    # workflows refreshed per sync cycle
#PROFILE_BUDGET_MS=15000
#PROFILE_INTERVAL_HOURS=24       # how old a profile may get before a rebuild

# --- Fingerprinting & metadata ---
#FINGERPRINT_CHUNK=2000
#FINGERPRINT_BUDGET_MS=10000
#SYNC_METADATA_VALUES=true       # false keeps the keys, drops the values
#METADATA_VALUE_MAX=512          # matches n8n's own cap

# --- Logging ---
#LOG_LEVEL=info                  # error | warn | info | debug
#LOG_FORMAT=json                 # json | pretty (default: pretty on a TTY)
#SLOW_REQUEST_MS=2000            # requests above this are logged at warn
#SYNC_RUN_HISTORY=500            # rows kept in sync_runs
#SAVE_DEBUG_ERRORS=false         # writes raw node input to disk — leave off
#CONCURRENCY_LOOKBACK_MS=3600000 # how far back the concurrency sweep looks

# --- Limits ---
#API_RATE_LIMIT_PER_MINUTE=300   # ceiling per user across /api

# --- Postgres timeouts ---
#DASHBOARD_DB_STATEMENT_TIMEOUT_MS=60000
#DASHBOARD_DB_CONNECT_TIMEOUT_MS=15000
```

### Standard installation

```bash
npm install
npm run build:css     # only needed if you change public/css/input.css
npm start             # → http://localhost:3000
```

### Docker installation

> [!CAUTION]
> **You must mount a volume at `/data`.**
> The replica holds execution history that n8n has already pruned from PostgreSQL — **it cannot be rebuilt from the source database**. Without a volume the replica lives inside the container and every redeploy destroys the entire archive, leaving you with only whatever still exists in n8n's retention window.

```bash
docker build -t n8n-dashboard .
docker volume create n8n_dashboard_data
docker run -d --name n8n-dashboard -p 3000:3000 \
  --env-file .env \
  -v n8n_dashboard_data:/data \
  n8n-dashboard
```

> [!WARNING]
> **Upgrading a deployment created before the container ran unprivileged.**
> The image now runs as the `node` user (uid 1000) instead of root. Docker applies the image's ownership only to a volume it creates **empty** — a volume that already exists is left exactly as it was, so one written by an older root container stays root-owned and the new container cannot open its own database. Run this once, before deploying:
>
> ```bash
> docker run --rm -v n8n_dashboard_data:/data alpine chown -R 1000:1000 /data
> ```
>
> If you forget, nothing is damaged: the app refuses to start and prints that exact command.

#### Docker Compose

```yaml
services:
  dashboard:
    build: .
    ports:
      - "3000:3000"
    env_file: .env
    environment:
      DASHBOARD_DB_PATH: /data/dashboard.sqlite
    volumes:
      - dashboard_data:/data
    restart: unless-stopped

volumes:
  dashboard_data:
```

#### Easypanel / other PaaS

Add a **Volume** mount *before* your first deploy:

| Setting | Value |
|---|---|
| Type | Volume |
| Name | `dashboard-data` |
| Mount path | `/data` |

The image already defaults `DASHBOARD_DB_PATH` to `/data/dashboard.sqlite`, so the mount alone is enough — but setting the variable explicitly documents the dependency.

Note that the volume is created when the first container starts, not when you save the configuration, and platforms typically namespace it as `<project>_<service>_<volume>`.

---

## ⚖️ Running more than one instance

The replica is a single SQLite file, and two processes running the ETL against it will corrupt it — *quietly*. During development, `PRAGMA integrity_check` returned `ok` on a file that had silently lost 86% of its rows. The damage was only visible by comparing row counts by hand.

**You do not have to configure anything to be safe from this.** The application enforces a single writer itself:

- On startup, and every few seconds after, each instance tries to claim an ETL lock stored **inside the replica**.
- Exactly one wins. That instance runs the sync.
- Every other instance serves the dashboard normally and simply never writes. `/api/health/deep` reports `etl.role` as `writer` or `reader`, so you can always tell which is which.
- If the writer stops cleanly, it hands the lock back and a replacement picks it up immediately. If it is killed outright, the lock expires after `ETL_LOCK_TTL_MS` (default 60s) and another instance takes over on its own.

The lock lives in the database file rather than in a lock file or your orchestrator's config, which means it has the correct scope everywhere with nothing to set up: Docker Swarm, Portainer, plain `docker run`, Kubernetes, systemd, or two terminals on a laptop. Processes that can corrupt each other are exactly the processes that share the file — and therefore exactly the processes that can see each other's lock.

A useful consequence: if you want several instances behind a load balancer for read throughput, that already works. One syncs, the rest serve.

### Platform settings (optional)

These no longer prevent corruption — the lock does. They only shorten the window in which a second instance is up and the data is briefly not being refreshed.

- Keep the service at **1 replica** unless you specifically want read scaling.
- On **Docker Swarm** (used under the hood by Easypanel and several PaaS providers), prefer `stop-first` so the old task is gone before the new one starts:
  ```bash
  docker service update --update-order stop-first <service>
  ```
- On Swarm, stop and start with `docker service scale <service>=0` / `=1`. `docker stop`/`docker start` leaves an orphan container that Swarm does not manage.

> [!NOTE]
> The lock only governs the ETL. Several instances may hold the file open and make small writes (settings, chat history); WAL journaling and `busy_timeout` handle that. It is bulk concurrent writing that destroys the file, and that is what is prevented.

---

## 🧰 Operating it

### Logs

Levelled and structured. `LOG_LEVEL` is `error | warn | info | debug` (default `info`), and the format defaults to human-readable on a terminal and JSON everywhere else, so a developer and a log shipper each get what they need without configuring anything.

Each ETL pass reports its stages as `[n/13]`, so a sync in progress is
distinguishable from one that finished quietly. The position is fixed per stage
rather than counted, so `[9/13]` means the same thing on every run — and a stage
with nothing to do prints nothing, which is why the numbers skip:

```
INFO  [SYNC] [1/13] workflows — 163 synced
INFO  [SYNC] [2/13] permissions — 1 projects, 1 memberships, 163 workflow shares
INFO  [SYNC] [5/13] executions — 2654 new or changed (3154 rows read)
INFO  [SYNC] [7/13] error details — 5 extracted, 0 failed, 0 still queued
INFO  [SYNC] [13/13] replica up to date — 2654 executions synced
INFO  [HTTP] GET /api/analytics/metrics 200 id=8f2a1c04 method=GET status=200 ms=41 user=…
```

Every `/api/*` response carries an `X-Request-Id`, echoed from the caller's own header when it sends one. Paste it into a log search to get that request and everything it caused. Values for keys that look like credentials — `password`, `token`, `authorization`, `apiKey`, `*_secret` — are replaced with `[redacted]` before anything is written, at any nesting depth.

### Sync history

Every ETL pass writes a row to `sync_runs`: duration, rows read, executions changed, errors extracted, retention effects, and the size of the replica. The last 500 are kept. It is the quickest answer to "when did this last succeed" and "is it getting slower":

```sql
SELECT started_at, status, duration_ms, executions, replica_bytes/1048576 AS mb
FROM sync_runs ORDER BY id DESC LIMIT 20;
```

### Dashboard health

The same table, read for you: **Settings → Dashboard Health**. When the last pass ran and whether it worked, a bar per pass so a pipeline getting slower is visible as a shape, the analytics queue, the fingerprint backlog, the size of the replica and what a VACUUM would reclaim.

The header of every page carries the short version — *synced 3m ago*, amber when a pass is late, red when three intervals have gone by. Two ages are reported separately and on purpose: how long since the ETL finished, and how old the newest execution is. Them disagreeing is the interesting case — the pipeline is fine and n8n has gone quiet — and the panel names it rather than leaving you to infer it.

This exists because it was needed. The first time it ran it reported the last ETL pass as failed, with `cannot start a transaction within a transaction`: two schedulers on one SQLite connection, opening transactions over each other. It had been written to `sync_runs` all along and nobody was reading it.

### Rate limits

| What | Limit | Keyed on |
|---|---|---|
| Failed logins, one account | 10 / 15 min | source address + email |
| Failed logins, one source | 30 / 15 min | source address |
| AI chat | 5 / min | user |
| Forced sync | 2 / min | user |
| Everything else under `/api` | 300 / min (`API_RATE_LIMIT_PER_MINUTE`) | user, falling back to address |

The login, AI and sync counters live in the replica, so a restart, a rolling deploy or a second instance does not hand a caller a fresh allowance. The per-account login limit includes the source address deliberately: keyed on the email alone, anyone who knows your address could lock you out of your own dashboard by failing ten logins.

### Retention

The error analytics row is never deleted — every count, category and chart keeps working. Only the raw evidence behind old rows is cleared, and the two heavy columns are governed separately because they are not the same kind of data:

- `input_data` is the payload that entered the failing node. Nothing in the dashboard reads it, so it is cleared after `ERROR_DETAIL_RETENTION_DAYS` (default 30).
- `error_stack` is kept forever by default. When the classifier's rules improve, the message and category of every stored error are re-derived **from it**; clearing it means those rows can never be corrected. Set `ERROR_STACK_RETENTION_DAYS` only if you have decided that trade is worth the disk.

Clearing a column frees pages for reuse, so the file stops growing — it does not shrink. To reclaim the space, run `node src/scripts/optimizeReplica.js --apply` with the app stopped.

### Tests and linting

```bash
npm run lint     # eslint
npm test         # node --test: unit + integration
npm run check    # both, the same gate CI applies before deploying
```

The integration suite boots the real server against a temporary SQLite file and calls every endpoint. It needs no PostgreSQL and no n8n instance, deliberately — a test that cannot run in CI does not run at all. Pushing to `main` runs lint and tests first; the deploy webhook is only called if they pass.

---

## 💾 Backup, restore, and verification

The replica is the only copy of pruned history. Back it up on a schedule:

```bash
docker exec n8n-dashboard \
  sh -c 'sqlite3 /data/dashboard.sqlite ".backup /data/backup.sqlite"' \
  && docker cp n8n-dashboard:/data/backup.sqlite ./dashboard-$(date +%F).sqlite
```

### Migrating an existing replica into a volume

**Stop the app first.** Copying a file out from under a live writer produces a corrupt result.

```bash
docker stop n8n-dashboard                                    # or: docker service scale <svc>=0
docker cp dashboard.sqlite n8n-dashboard:/data/dashboard.sqlite
docker start n8n-dashboard                                   # or: docker service scale <svc>=1
```

### Verifying a copy or a backup

> [!IMPORTANT]
> `PRAGMA integrity_check` proves the file is *structurally* valid. It does **not** prove the data is complete — it will happily return `ok` on a truncated replica.

Verify both:

```bash
# 1. Structural
sqlite3 backup.sqlite "PRAGMA integrity_check;"          # expect: ok

# 2. Content — compare against the source
sqlite3 backup.sqlite "SELECT COUNT(*), MIN(\"startedAt\") FROM execution_entity;"
md5sum dashboard.sqlite backup.sqlite                    # after a cold copy, these must match
```

### Offline maintenance

`src/scripts/optimizeReplica.js` performs schema and data maintenance the running app does not: cleaning orphaned rows, marking stuck executions as crashed, `ANALYZE`, and `VACUUM`. It reports without changing anything unless you pass `--apply`, and it needs roughly twice the database size in free disk for the `VACUUM` step.

```bash
# with the app stopped
node src/scripts/optimizeReplica.js            # dry run
node src/scripts/optimizeReplica.js --apply
```

---

## 📄 License

MIT — see [LICENSE](LICENSE).

---

**Legal disclaimer:** This project is an independent, community-made tool and is **not** affiliated with, endorsed by, or sponsored by n8n.io.
