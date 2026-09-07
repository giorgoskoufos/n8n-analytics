# Security

*What this dashboard can reach, what it deliberately cannot, and where each
guarantee actually lives — in a check the code cannot skip, not in a policy
someone has to remember to enforce.*

For the AI assistant's own sandbox — the part of this system with the most to
prove, since it turns natural language into database access — see
[../ai/developers.md](../ai/developers.md#safety-strongest-first). This
document covers everything around it: what gets copied out of n8n, who gets
to see what, and how secrets are stored.

---

## The rule everything else follows

**This application has no write path to your n8n database.** Not "doesn't use
one" — there is no `INSERT`/`UPDATE`/`DELETE` against PostgreSQL anywhere in
the codebase. Every one of the four places it touches Postgres is a read:

| # | When | What |
|---|---|---|
| 1 | Every `SYNC_INTERVAL_MINUTES` | The ETL sync |
| 2 | On login | A `bcrypt` comparison against n8n's own `user` table |
| 3 | On demand | One row from `execution_data`, when someone opens a specific failed execution's trace |
| 4 | Per sync cycle | A handful of `execution_data` rows, for node-level profiling |

A malicious or malformed AI query cannot even reach this list — it runs
against the local SQLite replica on a connection that cannot write, described
below. There is no route from "a model said something" to "production
changed."

---

## What gets copied out of n8n, and what deliberately does not

| Table | Copied | Left out, and why |
|---|---|---|
| `workflow_entity` | `id`, `name`, `active`, archive state, folder, timestamps, trigger count, description | The `nodes` column — the entire workflow definition — never |
| `execution_entity` | `id`, `workflowId`, `status`, timestamps, mode, retry columns, payload *sizes* | The `data` payload of successful executions — never |
| `credentials_entity` | `id`, `name`, `type`, timestamps | The `data` column — the encrypted credential blob, the single most sensitive column in n8n's schema |
| `workflow_history` | version id, workflow id, author, timestamp, autosave flag | The `nodes`/`connections` JSON — the actual workflow definition at that version. Mirroring it would turn a metadata replica into a copy of your intellectual property, for no feature that needs it |
| `execution_metadata` | keys only | Values — these are business identifiers a workflow chose to record, and they are treated as customer data by default |

### What the error extractor does store, and why it's different

When an execution fails, the ETL parses its payload into
`execution_error_analytics`: node name and type, error type, category,
timestamp — and also `error_stack`, `metadata`, and `input_data`.

> [!CAUTION]
> **`input_data` and `error_stack` can contain production data.** They hold
> the item that was being processed when the node threw — which may be
> customer records, tokens, anything flowing through the failing workflow.
> This is what makes the error modal genuinely useful for debugging, and it
> is also why `dashboard.sqlite` deserves the same care as your n8n database,
> not less.

Three consequences follow directly from that:

- **The AI assistant cannot reach these columns**, by construction rather than
  by rule — see below.
- **`input_data` is cleared after `ERROR_DETAIL_RETENTION_DAYS`** (default 30
  days), because nothing in the dashboard reads it once the debugging window
  has passed.
- **`error_stack` is kept indefinitely by default.** The error classifier
  re-derives category and message from it; clearing it means a future
  improvement to the classifier can never correct old rows. Set
  `ERROR_STACK_RETENTION_DAYS` only once you've decided that trade is worth
  the disk. See [../operations](../operations/README.md#retention).

---

## The AI assistant's sandbox, briefly

The full mechanism — four independent layers, each one stronger than the
one people assume is doing the work — is documented in
[../ai/developers.md](../ai/developers.md#safety-strongest-first). In short:

1. **The connection cannot write.** Opened `OPEN_READONLY`; a write attempt is
   `SQLITE_READONLY` from the SQLite engine itself, not a check in JavaScript
   that a bug could skip.
2. **The columns are not there.** The assistant's entire read surface is a set
   of `ai_*` views (`src/config/aiViews.js`), and views like `ai_errors` never
   define `input_data`, `error_stack`, or `error_message` in the first place.
   `SELECT input_data FROM ai_errors` fails as `no such column` — a database
   error, not a filtered response.
3. **Scope lives inside the view**, not in a clause the model's SQL has to
   respect. A temp table holding the caller's visible workflow ids is joined
   inside every scoped view, so a subquery or a `UNION` is still working
   against the *already filtered* relation. There is no shape of `SELECT`
   that gets underneath it.
4. **A statement guard** rejects anything naming a relation other than an
   `ai_*` view. This is the layer that looks like the security control and is
   actually the weakest of the four — everything above it holds even if this
   one is ever wrong.

The model never writes free SQL to answer an ordinary question; it calls one
of twenty-one fixed analyses, the same ones the dashboard's own pages call. The
`run_sql` escape hatch is opt-in per question and can be disabled entirely
with `AI_SQL_TOOL=off`.

---

## Authentication

The dashboard has no user database of its own — it authenticates directly
against your n8n users.

- **Same credentials as n8n.** Enter the email and password you already use
  there.
- **`bcrypt` comparison against n8n's own `user` table.** The raw password is
  never stored or logged by this application.
- **A missing account costs the same time as a wrong password.** The login
  handler always runs a `bcrypt.compare`, even when no user matched, against
  a dummy hash generated once at boot — otherwise response latency alone
  would reveal which emails exist.
- **Disabled and MFA-enabled n8n accounts are rejected.** A user with
  `disabled = true` in n8n cannot log in here either. A user with MFA enabled
  is blocked with an explanation, because this dashboard cannot verify a
  second factor it was never given.
- **Sessions are JWTs**, signed with `DASHBOARD_JWT_SECRET`, 8-hour expiry.
  The server refuses to boot if that secret is under 32 characters — a short
  secret is brute-forceable offline from a single captured token, and that
  failure needs to be loud at startup, not discovered later.

### Who sees what

Authentication decides *whether* you get in; authorization decides *what you
then see*, and it mirrors n8n's own project model rather than inventing a
separate one — the dashboard's `project`/`project_relation`/`shared_workflow`
tables are a wholesale mirror of n8n's, re-synced every cycle:

| n8n role | Sees |
|---|---|
| `global:owner`, `global:admin` | Everything. These roles can already open any workflow in n8n; scoping them here would report *fewer* executions than the instance actually ran, which reads as data loss, not as security. |
| Anything else | Only workflows in the projects that user belongs to — and every figure that hangs off a workflow id (executions, errors, ROI, volume) narrows with it. |

**Membership is re-mirrored wholesale, not incrementally.** Removing someone
from an n8n project is expressed by their row disappearing from
`project_relation` — a sync that only ever inserted or updated could never
observe a disappearance, and a revoked user would keep dashboard access
forever.

Two consequences worth knowing before adding a second user:

- **Instance-wide settings and forced syncs are owner/admin only** — both
  change something for everybody, gated by `requireElevatedRole`.
- **The AI assistant is available to every user**, scoped to what they can
  already see. It used to be owner/admin only, on the theory that a filter
  bolted onto a model-composed query is one subquery away from being
  stepped around. It no longer composes queries against the raw schema at
  all — the restriction lives inside the views themselves, where a subquery
  meets it rather than avoiding it.

> [!NOTE]
> The elevated-role check fails **open** when a role is unknown — n8n 1.x has
> no `roleSlug` column at all, so there is genuinely no way to distinguish an
> owner from a member on that version. Denying by default there would take a
> working feature away from every user of an entire n8n generation. Rate
> limiting is the actual backstop in that case, not the role check.

---

## Secrets

Two different tables, on purpose, holding two different kinds of thing:

- **`dashboard_settings`** — plain configuration (a timezone, a display
  preference). `GET /api/settings` returns every row in it to any
  authenticated page, which is correct for a timezone and would be
  catastrophic for a credential.
- **`dashboard_secrets`** — the OpenAI API key, and nothing else routes here
  today. It has its own reader (`aiConfig.apiKey()`, called only by the code
  that actually spends the key) separate from the one pages use to display
  *whether* something is configured (last four characters only, never the key
  itself).

Alert channel secrets (a Telegram bot token, a webhook's signing header) live
inside `alert_channels.config` as JSON, and are **redacted on every read**:
`redactConfig()` replaces a secret field with a fixed mask before it ever
reaches a browser response. Saving a channel without retyping its token
works by treating a masked or blank value as "keep what's stored" — resolved
per header row by name, specifically so that editing one header's name can
never silently move another header's secret onto it.

**No secret is ever echoed back**, including through the curl-export feature
(`GET /api/alerts/channels/:id/curl`) — the exported command shows the mask,
not the value.

**No secrets in logs.** The logger redacts any field whose key looks like a
credential (`password`, `token`, `authorization`, `apiKey`, `*_secret`, and
several more) at any nesting depth, before a line is ever written — to either
the console or the structured log file. See
[../operations](../operations/README.md#logs).

---

## What leaves your infrastructure

Nothing, by default. Every outbound destination below is off until you turn it
on, and the app has **no telemetry of any kind** — it never contacts the author
or any analytics service, in any configuration.

This table exists because "self-hosted" is a claim someone has to be able to
check before deploying at work. These four are the complete list; they are the
only external hosts the source contacts.

| Destination | Reached when | What is sent | Turned on by |
|---|---|---|---|
| **OpenAI** | The assistant answers a question | The question, the conversation so far, and the results of the analyses the model chose to run | Saving an API key in Settings → Integrations. No key, no calls. |
| **kapa.ai** (`n8n.mcp.kapa.ai`) | The assistant looks something up in the n8n documentation | The documentation question only — never your data | Connecting the docs integration, per user |
| **Telegram** (`api.telegram.org`) | An alert fires on a Telegram channel | The alert payload: rule name, title, body, subject and the numbers behind it | Creating a Telegram alert channel |
| **A URL you choose** | An alert fires on a webhook channel | The same alert payload | Creating a webhook alert channel |

Two things worth stating plainly:

- **kapa.ai is a third party, not n8n.** It is the service that powers n8n's
  own documentation search. "Ask the n8n docs" does not mean "talk to n8n
  GmbH", and anyone assuming otherwise would be wrong.
- **The alert payload can contain workflow names and error text** from your
  instance, which on some deployments is business-identifying. That is
  inherent to an alert being useful, but it is worth knowing before you point
  a channel at a third-party chat service.

To remove the assistant's ability to write SQL while keeping the rest, set
`AI_SQL_TOOL=off`. To have no outbound calls at all, simply configure none of
the four.

---


## Outbound requests: alert delivery

An alert channel's URL is a request this server makes on your behalf, and
only owners/admins can configure one — so `src/utils/alertValidation.js`'s
`validateUrl()` is a guard against misuse and mistake, not a privilege
boundary layered on top of one.

- **Link-local addresses are refused unconditionally, with no override.**
  `169.254.169.254` is the cloud metadata endpoint on every major provider;
  there is no deployment where an alert legitimately targets it.
- **Everything else private — including loopback — is refused by default**
  and can be allowed with `ALERT_ALLOW_PRIVATE_TARGETS=true`. n8n very often
  runs on the same host or private network as this dashboard, so posting to
  it is one of the most useful channels available; refusing `127.0.0.1`
  outright would break a legitimate single-host deployment to prevent
  nothing in particular.
- **Custom headers are name/value pairs with their own limits** — at most 10,
  RFC 7230-token names only, no `\r`/`\n` in a value (a line break in a header
  value is how one HTTP request becomes two), and a fixed set of
  dashboard-controlled headers (`Content-Type`, `Host`, `Content-Length`, …)
  cannot be overridden by a channel config.

---

## Frontend hardening

- **Strict CSP, no defaults.** `script-src 'self'` only — every third-party
  script (Chart.js, marked, DOMPurify, Font Awesome, highlight.js) is served
  from `public/vendor/`, never a CDN, so no external origin can supply script
  to a page holding an auth token, and a CDN outage or a breaking upstream
  release can never take the dashboard down with it.
- **`script-src-attr 'none'`.** Every inline `onclick=` was replaced by a
  `data-action` dispatcher (`public/logic/global_functions.js`) specifically
  so this directive could be turned on — with it active, a reintroduced
  inline handler fails loudly in the console instead of silently reopening
  an XSS hole.
- **`img-src` allows exactly one external origin**, `docs.n8n.io`, because the
  documentation tool's answers embed n8n's own screenshots. Nothing else may
  supply an image — an `<img>` from an arbitrary host in AI-rendered markdown
  is a beacon that reports the reader's address to whoever wrote the page the
  model quoted.
- **Rendered markdown passes through DOMPurify** with a restricted tag
  allowlist before it reaches the DOM — this is what makes it safe to render
  the assistant's (or the documentation service's) prose at all.

---

## Rate limits

| What | Limit | Keyed on |
|---|---|---|
| Failed logins, one account | 10 / 15 min | source address + email |
| Failed logins, one source | 30 / 15 min | source address |
| AI chat | 5 / min | user |
| Forced sync | 2 / min | user |
| Everything else under `/api` | 300 / min (`API_RATE_LIMIT_PER_MINUTE`) | user, falling back to address |
| `/healthz`, `/readyz` | 120 / min | source address |

Login, AI, and sync counters are stored in the SQLite replica itself, not in
process memory — so a restart, a rolling deploy, or a second instance never
hands an attacker a fresh allowance. The per-account login limit
deliberately includes the source address: keyed on email alone, anyone who
knows your address could lock you out of your own dashboard by failing ten
logins from anywhere.

---

## Reporting a concern

**Do not open a public issue for a security problem.** Use GitHub's private
vulnerability reporting -- the *Report a vulnerability* button under the
repository's Security tab.

[SECURITY.md](../../SECURITY.md) is the full policy: what is in scope, what is
not, and what response time to expect from a solo-maintained project.
