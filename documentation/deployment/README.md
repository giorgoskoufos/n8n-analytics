# Deployment

*Getting it running, correctly, the first time — including the mistake that
causes almost every support question this project gets: a missing volume.*

For running it well once it's up — logs, health, retention, alerting — see
[../operations](../operations/README.md). For the single-writer ETL lock referenced
throughout this page, see
[../architecture](../architecture/README.md#single-writer-election).

---

## Prerequisites

- **Node.js 20+** (the Docker image uses `node:22-alpine`; Node 18 is
  end-of-life).
- **Self-hosted n8n on PostgreSQL.** The ETL needs direct database access —
  n8n Cloud and n8n's default SQLite backend are both out of reach.
- **Read-only Postgres credentials are enough.** This application never
  writes to your n8n database — see [../security](../security/README.md).
- **An OpenAI API key**, only if you want the AI assistant. It's pasted into
  Settings after your first login — no environment variable required. See
  [../integrations](../integrations/README.md).

> [!WARNING]
> **Version compatibility.** The ETL reads a minimal slice of n8n's schema —
> workflow and execution metadata, plus `execution_data` on demand.

### Verified against

| n8n | PostgreSQL | Notes |
|---|---|---|
| **2.34.5** | 17 | The reference instance. Everything in this project was built and measured against it. |

Other 2.x releases are expected to work. The ETL does not assume a fixed
schema: it queries `information_schema.columns` for each table it reads and
builds its statements from the columns that are actually present, so a release
that adds or renames a column loses that one field rather than failing the
whole cycle.

**n8n 1.x is untested.** It is likely to work — the columns the ETL depends on
predate 2.x — with one known difference: 1.x has no role column, so the
elevated-role check
[fails open](../security/README.md#authentication) and every user is treated as
unrestricted. Do not run it on a shared 1.x instance where that matters.

If you run a version not in the table, please open an issue saying what worked
or broke. The list is short because one person is filling it in, not because
anything else is known to fail.

---

## Environment

Six variables are required. Copy the template and fill them in:

```bash
cp .env.example .env
```

| Variable | Notes |
|---|---|
| `DASHBOARD_JWT_SECRET` | Minimum 32 characters; the server refuses to boot below that. `openssl rand -base64 48` |
| `DASHBOARD_DB_HOST` | Your n8n PostgreSQL. See [Connecting to a PostgreSQL that runs in Docker](#connecting-to-a-postgresql-that-runs-in-docker) if it is a container. |
| `DASHBOARD_DB_PORT` | Usually `5432`. |
| `DASHBOARD_DB_NAME` | |
| `DASHBOARD_DB_USER` | Read-only credentials are enough, and are what you should use. |
| `DASHBOARD_DB_PASS` | |

In Docker, `DASHBOARD_DB_PATH` must point inside a mounted volume; the image
already sets it to `/data/dashboard.sqlite`, so there is nothing to do.

The AI assistant's key and model are deliberately **not** environment variables
-- see [../integrations](../integrations/README.md#the-ai-assistants-model-and-api-key).

**Around seventy further variables exist**, all optional, covering ETL batching,
retention, alerting, fingerprinting, profiling, logging and rate limits. They
are documented with their defaults and their reasoning in
**[environment.md](environment.md)**, which also marks which of them are
internal and not a supported interface.


## Standard installation

```bash
npm install
npm run build:css     # only if you've edited public/css/input.css
npm start              # → http://localhost:3000
```

---

## Docker installation

> [!CAUTION]
> **You must mount a volume at `/data`.** The replica holds execution history
> n8n has already pruned from PostgreSQL — **it cannot be rebuilt from the
> source database.** Without a volume the replica lives inside the container,
> and every redeploy destroys the entire archive, leaving you with only
> whatever's left inside n8n's own retention window. This is the single most
> common cause of data loss reported against this project.

```bash
docker build -t n8n-analytics .
docker volume create n8n_dashboard_data
docker run -d --name n8n-analytics -p 3000:3000 \
  --env-file .env \
  -v n8n_dashboard_data:/data \
  n8n-analytics
```

### Docker Compose

Compose files now live at the repository root and are the recommended way to
run this, so they are not restated here — a YAML block in prose is a file
someone has to reassemble by hand, and it drifts from the real one.

| File | Use |
|---|---|
| [`docker-compose.yml`](../../docker-compose.yml) | Pulls the published image. No clone needed. |
| [`docker-compose.build.yml`](../../docker-compose.build.yml) | Builds from a checkout. For contributors and unreleased commits. |

```bash
cp .env.example .env
docker compose up -d
```

`docker-compose.yml` also carries the commented network block for the case
where n8n's PostgreSQL is itself a container on this host — see
[Connecting to a PostgreSQL that runs in Docker](#connecting-to-a-postgresql-that-runs-in-docker)
below.

### Connecting to a PostgreSQL that runs in Docker

The most common failure on a first install, and it is not a configuration
mistake so much as a container-networking one:

```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

Inside a container, `127.0.0.1` is **that container**, not the host. If n8n's
PostgreSQL is itself a container, the dashboard has to join the network it is
already on and address it by service name.

1. Find the network. `docker network ls` — for a compose-managed n8n it is
   usually `<project>_default`, e.g. `n8n_default`.
2. Uncomment the two `networks:` blocks in
   [`docker-compose.yml`](../../docker-compose.yml) and replace `n8n_default`
   with the real name.
3. Set `DASHBOARD_DB_HOST` in `.env` to the **service name** of the Postgres
   container (commonly `postgres` or `db`), not an IP.

```bash
docker compose exec dashboard node -e "require('net').connect(5432,'postgres').on('connect',()=>{console.log('reachable');process.exit(0)}).on('error',e=>{console.log(e.message);process.exit(1)})"
```

If PostgreSQL runs on the **host** rather than in a container, the address is
`host.docker.internal` on Docker Desktop, or the host's IP on the bridge
network on Linux — and PostgreSQL must be listening on it, which by default it
is not (`listen_addresses` in `postgresql.conf`, plus a matching `pg_hba.conf`
line).


### Easypanel / other PaaS

Add a **Volume** mount *before* your first deploy:

| Setting | Value |
|---|---|
| Type | Volume |
| Name | `dashboard-data` |
| Mount path | `/data` |

The image already defaults `DASHBOARD_DB_PATH` to `/data/dashboard.sqlite`,
so the mount alone is enough — setting the variable explicitly just
documents the dependency for the next person reading the config.

> [!NOTE]
> The volume is created when the first container actually **starts**, not
> when you save the configuration, and platforms typically namespace it as
> `<project>_<service>_<volume>`.

### Upgrading a deployment created before the container ran unprivileged

The image now runs as the `node` user (uid 1000), not root. Docker only
applies the image's ownership to a volume it creates **empty** — a volume
that already exists is left exactly as it was, so one written by an older
root container stays root-owned, and the new container can't open its own
database file.

Run this once, before deploying the new image:

```bash
docker run --rm -v n8n_dashboard_data:/data alpine chown -R 1000:1000 /data
```

If you forget, nothing is damaged — the app refuses to start and prints this
exact command.

---

## First sync

A brand-new instance is only *partly* populated after its first ETL cycle —
several stages are deliberately time-boxed so a large instance's first sync
doesn't hold the write lock for minutes. The app fills in the rest
automatically: a first-run sheet shows a percentage while the pages are
still empty, then a `Catching up · 43%` line in the sidebar until it
finishes — usually minutes, not hours. See
[../architecture](../architecture/README.md#why-a-first-sync-takes-more-than-one-pass)
for the mechanism, and don't click "Sync now" repeatedly; it's already
running as fast as it can without saturating your n8n database.

### Enabling deep historical analytics

n8n prunes execution data frequently by default. To build long-term trends,
raise the retention window on your **n8n instance** (not this dashboard):

```env
EXECUTIONS_DATA_PRUNE=true
EXECUTIONS_DATA_MAX_AGE=720   # hours; check n8n's docs for the unit in your version
```

> [!NOTE]
> This grows your **n8n** PostgreSQL database. The dashboard's own replica
> stores lightweight metadata only — no workflow definitions, no execution
> payloads — so it stays small by comparison, and pruning in n8n never
> removes rows this dashboard has already synced: once a row is copied here,
> it stays, regardless of what n8n later does with the original.

---

## Running more than one instance

You don't have to configure anything to be safe from corruption — the app
elects a single ETL writer on its own; see
[../architecture](../architecture/README.md#single-writer-election). A useful
consequence: several instances behind a load balancer for read throughput
already works, unconfigured — one syncs, the rest serve.

These settings no longer prevent corruption (the lock does); they only
shorten the window where a second instance briefly isn't refreshing data:

- Keep the service at **1 replica** unless you specifically want read
  scaling.
- On **Docker Swarm** (used under the hood by Easypanel and several PaaS
  providers), prefer `stop-first` so the old task is fully gone before the
  new one starts: `docker service update --update-order stop-first <service>`.
- On Swarm, scale rather than `docker stop`/`start` —
  `docker service scale <service>=0` then `=1` — since `docker stop` leaves
  an orphan container Swarm doesn't manage.

---

## Backup, restore, and verification

The replica is the only copy of pruned history. Back it up on a schedule:

```bash
docker exec n8n-analytics \
  sh -c 'sqlite3 /data/dashboard.sqlite ".backup /data/backup.sqlite"' \
  && docker cp n8n-analytics:/data/backup.sqlite ./dashboard-$(date +%F).sqlite
```

### Migrating an existing replica into a volume

**Stop the app first** — copying a file out from under a live writer
produces a corrupt result.

```bash
docker stop n8n-analytics                    # or: docker service scale <svc>=0
docker cp dashboard.sqlite n8n-analytics:/data/dashboard.sqlite
docker start n8n-analytics                   # or: docker service scale <svc>=1
```

### Verifying a copy or a backup

> [!IMPORTANT]
> `PRAGMA integrity_check` proves the file is *structurally* valid. It does
> **not** prove the data is complete — it happily returns `ok` on a
> truncated replica.

```bash
# Structural
sqlite3 backup.sqlite "PRAGMA integrity_check;"          # expect: ok

# Content — compare against the source
sqlite3 backup.sqlite "SELECT COUNT(*), MIN(\"startedAt\") FROM execution_entity;"
md5sum dashboard.sqlite backup.sqlite                    # after a cold copy, these must match
```

### Offline maintenance

`src/scripts/optimizeReplica.js` does schema and data maintenance the
running app doesn't: cleaning orphaned rows, marking stuck executions as
crashed, `ANALYZE`, and `VACUUM`. Dry-run by default; needs roughly twice the
database size in free disk for the `VACUUM` step.

```bash
# with the app stopped
node src/scripts/optimizeReplica.js            # reports, changes nothing
node src/scripts/optimizeReplica.js --apply
```

---

## Upgrading dependencies that ship to the browser

Chart.js, `marked`, DOMPurify, Font Awesome, and Open Sans are all vendored
into `public/vendor/` rather than loaded from a CDN (see
[../frontend](../frontend/README.md#vendor-assets--nothing-from-a-cdn) for why). To
bump one:

```bash
npm install                        # update the version in package.json first
node src/scripts/vendorAssets.js   # re-copies node_modules → public/vendor
```

The copies are committed — the Docker build installs dependencies before the
source is copied in, so they must already be in the image.
