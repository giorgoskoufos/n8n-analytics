# Operations

*Running it day to day: reading the logs, telling a healthy pipeline from a
quiet one, alerting reference, retention, and rate limits.*

For getting it installed in the first place, see
[../deployment](../deployment/README.md). For the schema behind everything counted
here, see [../database](../database/README.md).

---

## Logs

Levelled (`error | warn | info | debug`, `LOG_LEVEL`, default `info`) and
split into **two independent sinks** that are never a forced either/or.

**Console** is a narrative, not a firehose. By default it shows `SYNC`,
`SERVER`, and `LOCK` at every level — the sync running, the process starting
and stopping, which instance currently owns the ETL lock — plus any
`warn`/`error` from *anywhere*, so a real problem never requires already
tailing a file to notice. An HTTP line reads like a request, not a field
dump:

```
INFO  [SYNC] [5/13] executions — 2654 new or changed (3154 rows read)
INFO  [HTTP] GET /api/analytics/metrics 200 id=8f2a1c04 ms=41 user=67af…
```

The method is bold and colour-coded like a REST client (GET green, POST
yellow, PUT blue, PATCH magenta, DELETE red), the status number is coloured
by range (green 2xx, cyan 3xx, yellow 4xx, red 5xx), and any field whose
value already appears in the message itself — `method`, `path`, `status`
here — is dropped from the trailing fields, since printing it twice adds
nothing. Fields that don't (`id`, `ms`, `user`) stay.

- `LOG_CONSOLE_COMPONENTS` — override the console allowlist, e.g.
  `SYNC,HTTP,ALERT`.
- `LOG_CONSOLE_COMPONENTS=*` — mirror **everything** the file gets onto the
  console too. The two sinks are independent controls, not a single choice
  between "quiet" and "everything."

**File** is the complete record, unaffected by any console-only filtering
above: every component, one JSON object per line, at `LOG_FILE` (default a
`logs/` folder beside the SQLite replica — nothing new to mount). Meant to be
picked up later by something else — Promtail, a Loki sidecar, `docker cp` for
a support bundle — without reconfiguring this app first. Rotates at
`LOG_FILE_MAX_BYTES` (default 10 MB), keeping `LOG_FILE_BACKUPS` (default 2),
because this file shares a volume with data that can't be re-synced from n8n
and must never be the reason that volume fills up. `LOG_FILE=off` disables
it.

Each ETL pass reports its 13 stages as `[n/13]` — see
[../architecture](../architecture/README.md#the-etl-pipeline) for the full list — so a
sync in progress is distinguishable from one that finished quietly, and a
stage with nothing to do prints nothing, which is why the numbers in a real
log skip around.

Every `/api/*` response carries an `X-Request-Id`, echoed back from the
caller's own header if it sent one — paste it into a log search to pull that
request and everything it caused. Any field whose key looks like a
credential (`password`, `token`, `authorization`, `apiKey`, `*_secret`, and
several more) is replaced with `[redacted]` before anything is written, at
any nesting depth, in **both** sinks — see
[../security](../security/README.md#secrets).

---

## Sync history

Every ETL pass writes a row to `sync_runs`: duration, rows read, executions
changed, errors extracted, retention effects, replica size. The last 500 are
kept — the quickest answer to "when did this last succeed" and "is it
getting slower":

```sql
SELECT started_at, status, duration_ms, executions, replica_bytes/1048576 AS mb
FROM sync_runs ORDER BY id DESC LIMIT 20;
```

**Settings → Dashboard Health** reads the same table for you: when the last
pass ran and whether it worked, a bar per pass so a pipeline getting slower
is visible as a shape, the analytics queue, the fingerprint backlog, the
replica's size, and what a `VACUUM` would reclaim.

The header on every page carries the short version — *synced 3m ago*, amber
when a pass is late, red once three intervals have gone by. **Two ages are
reported separately, on purpose**: how long since the ETL last finished, and
how old the newest execution actually is. Them disagreeing is the
interesting case — the pipeline is fine and n8n itself has gone quiet — and
the panel names that directly instead of leaving you to infer it from one
number.

---

## Alerting

Rules and channels are configured entirely from the **Alerts** page, not in
`.env` — see [../integrations](../integrations/README.md#alert-channels) for the
step-by-step setup. This section is the operating reference.

### The seven rule types

| Rule | Fires when | Threshold |
|---|---|---|
| `new_fingerprint` | A failure nobody has seen before | none — novelty isn't a quantity |
| `error_rate` | A workflow's error rate (first attempts only, so retries don't inflate it) exceeds X% over the window | 0.1–100% |
| `silent_death` | An active workflow is overdue by X× its own learned typical gap | 1.5–100× |
| `queue_lag` | The p95 wait between an execution being created and starting exceeds X ms | 1–3,600,000 ms |
| `volume_drop` | Executions fell below X% of the preceding window | 1–99% |
| `payload_spike` | Average payload per execution grew X× the preceding window | 1.2–100× |
| `db_growth` | Projected retained execution data exceeds X GB | 0.1–10000 GB |

### What it deliberately does

- **It goes quiet, not loud, when its own data is stale.** Measured against
  the freshest execution in the replica: if that's more than
  `ALERT_MAX_STALENESS_MS` (default 30 min) behind, the pass doesn't run at
  all, and the Alerts page shows a banner explaining why. Without this, a
  stalled ETL would make every scheduled workflow look silently dead at
  once — and an alerting system that cries wolf the moment its own pipeline
  hiccups gets switched off within a week.
- **It records what it suppressed.** "Why was I not told" has to be
  answerable after the fact, so a cooldown-suppressed or channel-less firing
  still writes a row to the event log, with the numbers behind the decision.
- **It writes the event before it sends it.** Delivery happens outside the
  replica's write lock — a slow webhook must never hold up the ETL — and a
  crash mid-send leaves a durable record the next pass retries, rather than
  an alert nobody hears about. Delivery gets its own timeout
  (`ALERT_TIMEOUT_MS`, default 10s) and retry budget (`ALERT_MAX_ATTEMPTS`,
  default 4), independent of the evaluation pass itself.

Cooldown and deduplication are keyed on `<rule id>:<subject>`, so two
different workflows tripping the same rule alert independently, while the
same workflow re-tripping inside its own cooldown window is suppressed (not
dropped — logged as suppressed).

Targets on private or loopback addresses are refused unless
`ALERT_ALLOW_PRIVATE_TARGETS=true`; link-local is always refused. See
[../security](../security/README.md#outbound-requests-alert-delivery).

---

## Rate limits

| What | Limit | Keyed on |
|---|---|---|
| Failed logins, one account | 10 / 15 min | source address + email |
| Failed logins, one source | 30 / 15 min | source address |
| AI chat | 5 / min | user |
| Forced sync | 2 / min | user |
| Everything else under `/api` | 300 / min (`API_RATE_LIMIT_PER_MINUTE`) | user, falling back to address |

Stored in the replica, not in process memory — a restart, a rolling deploy,
or a second instance never hands anyone a fresh allowance. See
[../security](../security/README.md#rate-limits) for why the login limit is
deliberately keyed on the source address as well as the account.

---

## Retention

The error analytics row is **never deleted** — every count, category, and
chart keeps working forever. Only the raw evidence behind old rows is
cleared, and the two heavy columns are governed separately because they
aren't the same kind of risk:

- **`input_data`** — the payload that entered the failing node. Nothing in
  the dashboard reads it once the debugging window has passed, so it's
  cleared after `ERROR_DETAIL_RETENTION_DAYS` (default 30 days).
- **`error_stack`** — kept forever by default. When the error classifier's
  rules improve, the category and message of *every stored row* are
  re-derived **from it**; clearing it means those rows can never be
  corrected later. Set `ERROR_STACK_RETENTION_DAYS` only once you've decided
  that trade is worth the disk.

Clearing a column frees pages for reuse — the file stops growing, it doesn't
shrink. To actually reclaim the space, run
`node src/scripts/optimizeReplica.js --apply` with the app stopped; see
[../deployment](../deployment/README.md#offline-maintenance).

---

## Troubleshooting

**"Sync says complete but the numbers still look wrong / too low."** Check
whether the instance is still in its first catch-up window — see
[../deployment](../deployment/README.md#first-sync). During catch-up, every total on
every page is a floor, not the final answer, and the sidebar's
`Catching up · X%` line outranks "Synced 12s ago."

**"The AI assistant errored with a database constraint failure."** This
almost always means the local `users` row for your session doesn't exist —
which happens if the replica was ever reset (a fresh volume, a redeploy that
lost data) while your browser still held a valid, unexpired session token.
Log out and back in; the login flow re-creates that row immediately, and
every authenticated request does the same from then on so it can't recur for
that session again.

**"Two containers are both running and I'm worried about corruption."** You
don't need to do anything — see
[../architecture](../architecture/README.md#single-writer-election). Check
`/api/health/deep`'s `etl.role` on each instance to confirm which one is
actually writing.

**"`docker stop` killed the container instead of shutting it down cleanly."**
Confirm `SHUTDOWN_TIMEOUT_MS` (default 8s) is comfortably under your
orchestrator's stop grace period (Docker's default is 10s) — if the grace
period is shorter, the `SIGKILL` lands before the graceful drain finishes.
See [../architecture](../architecture/README.md#graceful-shutdown).

---

## Tests and linting

```bash
npm run lint     # eslint
npm test         # node --test: unit + integration
npm run check    # both — the same gate CI applies before deploying
```

Pushing to `main` runs lint and tests first; the deploy webhook only fires if
they pass.
