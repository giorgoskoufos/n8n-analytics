# n8n Analytics Dashboard

> [!NOTE]
> This is a **community project**, free to use and open to contributions. Suggestions, issues, and pull requests are welcome.

A high-performance analytics dashboard for **self-hosted n8n**. It syncs execution metadata out of your n8n PostgreSQL database into a local SQLite replica, and serves every chart, table, and AI query from that replica — so your production n8n never carries analytical load, and history that n8n has already pruned stays available here for good.

---

## Who this is for

Anyone running their own n8n instance who wants long-horizon analytics without migrating to n8n Cloud or buying an enterprise license.

n8n 2.x does ship insights tables in self-hosted installs, but your **license tier** decides how much of that data actually surfaces in the editor UI — the data is there either way. Separately, n8n prunes execution rows aggressively by default. This project fills both gaps:

- **Long-horizon history** — the replica keeps rows n8n has already deleted from PostgreSQL. Once synced, a row stays.
- **Zero load on production** — every analytics and AI query runs against the SQLite replica, never your n8n database.
- **Operational depth** — node-level failure analysis, blast-radius dependency mapping, ROI tracking, natural-language querying.
- **Your hardware, your data** — nothing leaves your infrastructure except the AI assistant's calls to OpenAI, which is entirely optional.

> [!IMPORTANT]
> **Hard requirements**
> 1. **Self-hosted n8n only** — the ETL needs direct database access.
> 2. **PostgreSQL only** — n8n's default SQLite backend is not supported.
> 3. **A persistent volume for the replica** — see [Getting started](#getting-started). This is the single most common cause of reported data loss.
>
> Running more than one instance is *not* something to avoid — the app elects a single ETL writer on its own. See [documentation/deployment](documentation/deployment#running-more-than-one-instance).

> [!WARNING]
> Built and tested against **n8n 2.x on PostgreSQL 17**. n8n 1.x is expected to work but isn't actively verified. A major n8n schema change may need a sync-job update; day-to-day analytics run off the local replica and are unaffected either way.

---

## What you get

- **Real-time metrics** — total executions, error counts, average runtimes, period-over-period deltas.
- **Execution timeline** — successes vs. errors over any window, with active-bucket forecasting so the current partial bucket doesn't read as a crash.
- **Error Intelligence** — node-level failure analysis, deduplicated error groups, category breakdown, and the upstream origin nodes that triggered each crash.
- **Trigger-type analysis** — every figure splittable by how an execution started. On the instance this was built against, webhooks fail at 4.0% and schedules at 1.1%, while a blended rate reported 3.9% for everything — a real number about the wrong thing.
- **Queue lag** — p50/p95/p99 wait between an execution being created and starting, with a backpressure signal that fires only when lag climbs while throughput doesn't. No n8n tool measures this.
- **Storage forecast** — which workflows the database's size actually comes from, and where it's heading, accounting for n8n's own pruning.
- **Retry-aware error rates** — raw and effective side by side, so a failure that succeeded on retry stops reading as an outage.
- **Error fingerprinting** — failures grouped by what actually broke, not by message text. 14,271 errors collapsed to 98 real groups on one instance.
- **Silent death detection** — an active workflow that quietly stopped running raises nothing in n8n. This learns each workflow's own cadence and flags the ones that missed it.
- **Blast radius** — which workflows share a credential or a node type. One credential on the reference instance is used by 42 workflows.
- **Deploy correlation** — error rates compared across saved versions of the same workflow, with author and timestamp — git blame for automations.
- **Node-level execution profiling** — where a workflow's time actually goes, node by node, including nodes that failed inside executions n8n recorded as successful.
- **Alerting** — seven rule types, delivered by webhook, Telegram, or an n8n workflow, with deduplication, cooldown, and a refusal to fire when the replica is too stale to judge.
- **ROI analytics** — per-workflow time-and-money-saved tracking, with a coverage indicator so a total from a partly-configured instance reads as the floor it is, not a measurement.
- **AI analytics assistant** — natural-language questions answered by calling the dashboard's own analyses, so its numbers can never disagree with the pages.
- **Folders, tags, and projects** — every figure filterable by n8n's own structure.
- **Security defaults** — JWT auth against your existing n8n users, rate limiting, a strict CSP, sanitized rendering, no write path to n8n at all.

---

## How it works

```
n8n PostgreSQL  ──ETL every 5 min──▶  dashboard.sqlite  ──▶  Express API  ──▶  Browser UI
   (read-only)                             ▲                                      │
                                            └────────  AI tools + read-only views  ◀────┘
```

The ETL copies a narrow set of columns — never workflow definitions, never credential contents, never payloads — from n8n's `workflow_entity` and `execution_entity` into the local replica, and extracts structured error detail from failed executions. Everything the dashboard renders, including the AI assistant's answers, is read from that replica.

PostgreSQL is touched in exactly four places, all of them reads: the ETL sync, login, on-demand execution trace fetches, and node profiling. Nothing in the codebase writes to your n8n database.

**→ Full mechanism, the 13-stage ETL pipeline, and the single-writer lock:** [documentation/architecture](documentation/architecture)

---

## Getting started

### Prerequisites

- **Node.js 20+**
- **Read-only PostgreSQL access** to your n8n database
- **An OpenAI API key** — only if you want the AI assistant; paste it into Settings after your first login, no environment variable needed

### Quick start

```bash
npm install
cp .env.example .env    # fill in DASHBOARD_JWT_SECRET and your n8n Postgres credentials
npm start                # → http://localhost:3000
```

### Docker (recommended for anything long-running)

> [!CAUTION]
> **You must mount a volume at `/data`.** The replica holds history n8n has already pruned and **cannot be rebuilt from the source database**. Without a volume, every redeploy destroys the archive.

```bash
docker build -t n8n-dashboard .
docker volume create n8n_dashboard_data
docker run -d --name n8n-dashboard -p 3000:3000 \
  --env-file .env \
  -v n8n_dashboard_data:/data \
  n8n-dashboard
```

**→ Full environment reference, Docker Compose, Easypanel/PaaS setup, upgrading, backup and restore:** [documentation/deployment](documentation/deployment)

---

## Documentation

Reference documentation lives in [`documentation/`](documentation), one topic per folder. This README stays a map and a quick start; each of these goes deep on its own subject.

| Folder | Covers |
|---|---|
| [architecture](documentation/architecture) | The request lifecycle, the 13-stage ETL pipeline, the single-writer lock, graceful shutdown |
| [database](documentation/database) | Every table — what's mirrored from n8n, what's dashboard-only, and the `ai_*` views |
| [api](documentation/api) | Every REST endpoint: method, path, auth level, params |
| [backend](documentation/backend) | Code layout, the DAO convention, scope vs. grouping, how to add an endpoint |
| [frontend](documentation/frontend) | The no-bundler vanilla-JS frontend, page structure, the auth guard, adding a page |
| [ai](documentation/ai) | The assistant: what it can answer ([how-it-works.md](documentation/ai/how-it-works.md)) and how it's built ([developers.md](documentation/ai/developers.md)) |
| [integrations](documentation/integrations) | Step-by-step: connecting OpenAI, the n8n documentation lookup, and alert channels |
| [security](documentation/security) | What's synced and what isn't, the AI sandbox, secrets, auth, rate limits |
| [operations](documentation/operations) | Logs, health, alerting reference, retention, troubleshooting |
| [deployment](documentation/deployment) | Full install reference: environment variables, Docker, backup/restore, upgrading |

---

## Getting started, by scenario

A few concrete starting points, each pointing at the doc that finishes the job.

**"I just deployed this — what do I do first?"**
Log in with your n8n credentials. The dashboard starts syncing immediately; a first-run screen shows a percentage while it fills in. It's usually done in minutes, not hours — see [First sync](documentation/deployment#first-sync). Nothing else is required to see your data.

**"I want the AI assistant answering questions in chat."**
Settings → Assistant → paste an OpenAI API key → Save. That's the whole setup — see [Connecting the assistant](documentation/integrations#the-ai-assistants-model-and-api-key). Ask it something like *"which workflow failed most this week?"* and open *"How this was worked out"* under the answer to see exactly which analyses it ran.

**"I want a Telegram message the moment a workflow starts failing."**
Alerts → New channel → Telegram, then Alerts → New rule → *"Error rate above a percentage."* Full walkthrough with exact fields: [Alert channels](documentation/integrations#alert-channels).

**"My n8n prunes executions after a few days and I want longer history."**
This dashboard already keeps everything it's synced, forever, by default. Raise n8n's own retention window if you also want n8n's editor UI to see further back — see [Enabling deep historical analytics](documentation/deployment#first-sync).

**"One workflow is slow and I don't know why."**
Open its error/insights drill-down, or just ask the AI assistant *"why is `<workflow>` slow, where does the time go?"* — it profiles node by node. See [Node-level execution](documentation/ai/how-it-works.md#what-is-slow-and-where-the-time-goes).

**"I'm a developer and want to add a new metric."**
One function in a DAO, one entry in a controller/route, done — and if it should also be askable in chat, one more entry reusing the same DAO call. See [Adding a new endpoint](documentation/backend#adding-a-new-endpoint) and [Adding an analysis](documentation/ai/developers.md#adding-to-it).

**"I want to know exactly what data leaves my infrastructure."**
Nothing, except calls to OpenAI if you've configured the AI assistant — and even those never include raw customer data. Full breakdown: [What's synced](documentation/security#what-gets-copied-out-of-n8n-and-what-deliberately-does-not).

---

## Authentication

No separate user system — this dashboard authenticates directly against your existing n8n users. Log in with the same email and password; a `bcrypt` comparison runs against n8n's own `user` table, and disabled or MFA-enabled n8n accounts are rejected here too. Authorization mirrors n8n's own project model: owners and admins see everything, everyone else sees only workflows in their own projects.

**→ Full model, including why the AI assistant is scoped differently from instance-wide settings:** [documentation/security](documentation/security#authentication)

---

## AI Chat Assistant

> **In depth:** [documentation/ai/how-it-works.md](documentation/ai/how-it-works.md) — what you can ask it, what it refuses, and how to check an answer. No code. [documentation/ai/developers.md](documentation/ai/developers.md) — the request lifecycle, the four safety mechanisms, and how to add an analysis.

The assistant answers by calling the dashboard's own analyses rather than by writing queries. Ask *"why did Call Center fail yesterday"* and it looks up what *Call Center* is, reads the error intelligence for that folder, and drills into the group that stands out — the same steps a person would take.

It reaches 21 fixed analyses, a searchable catalogue of every workflow/folder/tag/error group, and optionally the official n8n documentation. It **cannot** reach execution payloads, raw error messages, stack traces, credentials, or other users' conversations — not by application-level filtering, but because those columns are absent from the SQLite views its connection can even see. See [documentation/security](documentation/security#the-ai-assistants-sandbox-briefly) for the four independent layers behind that guarantee.

Requires an OpenAI API key, set in **Settings → Assistant**; the rest of the dashboard works without one.

---

## Stack

**Backend** — Node.js + Express 5, modular MVC (routes → controllers → DAOs). No ORM; hand-written SQL behind a shared scoping layer. See [documentation/backend](documentation/backend).

**Frontend** — vanilla JS, no framework, no bundler, no build step except Tailwind CSS (which is compiled). Every third-party script is vendored, not loaded from a CDN. See [documentation/frontend](documentation/frontend).

**Database** — SQLite, applied through an ordered, idempotent set of migrations. WAL journaling, a 5s busy timeout, and indexes covering the dashboard's own access patterns. See [documentation/database](documentation/database).

```bash
npm run lint     # eslint
npm test         # node --test: unit + integration
npm run check    # both — the same gate CI applies before deploying
```

---

## Operating it

Logs are split into a narrative console and a complete structured file, health is visible in the sidebar of every page, and retention is configurable per column. None of it requires an external observability stack to start.

**→ Full reference:** [documentation/operations](documentation/operations)

---

**Legal disclaimer:** This project is an independent, community-made tool and is **not** affiliated with, endorsed by, or sponsored by n8n.io.
