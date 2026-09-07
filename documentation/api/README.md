# API Reference

*Every route this server answers, what it needs, and who's allowed to call
it. Built from `server.js` and `src/routes/*.js` directly.*

All routes are mounted under `/api` except the two bare health probes. For
the middleware chain each router applies and *why* it's ordered the way it
is, see [../architecture](../architecture/README.md#request-lifecycle). For what
"scoped" means in the Auth column below, see
[../security](../security/README.md#who-sees-what).

**Auth levels used throughout this page:**

| Level | Means |
|---|---|
| **Public** | No token required |
| **Authenticated** | Any signed-in user; further narrowed to their visible workflows by `resolveScope` unless noted |
| **Elevated** | `global:owner` / `global:admin` only, via `requireElevatedRole` — **fails open** on n8n 1.x, which has no role column at all |

**Rate limiters**, applied per bucket regardless of endpoint: `loginLimiter`
(10/15min per account+IP, 30/15min per IP), `aiLimiter` (5/min/user, chat
only), `syncLimiter` (2/min/user, force-sync only), `globalApiLimiter`
(300/min, default for everything else under `/api`), `healthLimiter`
(120/min, the two bare probes).

---

## Health

Registered directly in `server.js`, not in `src/routes/`.

| | Purpose | Auth |
|---|---|---|
| `GET /healthz` | Liveness — no I/O at all | Public |
| `GET /readyz` | Readiness — cached `SELECT 1` against Postgres, 20s TTL | Public |
| `GET /api/health/deep` | Diagnostic: Postgres status, replica row count, which instance holds the ETL lock | Authenticated |

---

## Auth

`src/routes/authRoutes.js`

| | Purpose | Auth | Notes |
|---|---|---|---|
| `POST /api/login` | Exchange n8n credentials for a dashboard JWT | Public | Body: `email`, `password`. Constant-time check against a dummy hash even when no user matches. Rejects disabled and MFA-enabled n8n accounts. Returns `{ token, user: { firstName, lastName, email } }`, 8h expiry |

---

## Metrics

`src/routes/metricsRoutes.js` → `metricsController.js`. Grouping filters
(`?workflow=`, `?folder=`, `?tag=`, `?project=`) apply wherever noted; an id
naming nothing 400s via `verifyGrouping` before the handler runs.

| | Purpose | Auth | Notes |
|---|---|---|---|
| `GET /api/analytics/metrics` | Headline KPI numbers | Authenticated, scoped | Date range + grouping |
| `GET /api/analytics/executions` | Execution list/aggregates | Authenticated, scoped | |
| `GET /api/analytics/slowest` | Slowest executions | Authenticated, scoped | |
| `GET /api/analytics/errors` | Error list | Authenticated, scoped | |
| `GET /api/execution-error/:id` | One execution's error detail | Authenticated, scoped | `?full=true` for the raw payload |
| `GET /api/executions/:id/trace` | Node-level timing for one execution | Authenticated, scoped | One of the three places this app reads `execution_data` from Postgres on demand; never the payload itself |
| `POST /api/sync/force` | Trigger an immediate ETL pass | **Elevated** | 2/min. 409 if already running or this instance isn't the ETL lock owner |
| `GET /api/n8n-health` | Proxy-check n8n's own `/healthz` | Authenticated | 3.5s timeout |
| `GET /api/settings/roi` | Read per-workflow ROI inputs | Authenticated, scoped | |
| `POST /api/settings/roi` | Write per-workflow ROI inputs | Authenticated | Up to 1000 entries, all-or-nothing validation |
| `GET /api/settings` | Read instance-wide settings | Authenticated | Every `dashboard_settings` row — never a secret, see [../security](../security/README.md#secrets) |
| `POST /api/settings` | Write an instance-wide setting | **Elevated** | Changes apply for everybody |
| `GET /api/analytics/roi` | ROI totals | Authenticated, scoped | |
| `GET /api/analytics/first-execution-date` | Earliest execution date in scope | Authenticated, scoped | |
| `GET /api/analytics/execution-volume` | Executions-started time series | Authenticated, scoped | |
| `GET /api/analytics/execution-volume/details` | Row-level drilldown for one bar | Authenticated, scoped | |
| `GET /api/analytics/error-intelligence` | Aggregated error-group analytics | Authenticated, scoped | |
| `POST /api/analytics/error-group-executions` | Executions in one error group | Authenticated, scoped | |
| `GET /api/analytics/workflow-drilldown/:id` | Error drilldown for one workflow | Authenticated, scoped | |

---

## Insights

Same router as Metrics → `insightsController.js`. Date range params are
`startDate`/`endDate` (default 7 days, most capped at 60).

| | Purpose | Auth | Notes |
|---|---|---|---|
| `GET /api/analytics/triggers` | Split by trigger type | Authenticated, scoped | |
| `GET /api/analytics/queue-lag` | Percentile queue lag | Authenticated, scoped | `?mode=` for execution mode |
| `GET /api/analytics/storage` | DB growth / storage forecast | Authenticated, scoped | `?days=` 1–120, default 30 — whole-instance, not date-range bounded |
| `GET /api/analytics/concurrency` | True concurrent-execution count | Authenticated, scoped | Max 7-day window |
| `GET /api/analytics/reliability` | Raw vs. retry-aware error rate | Authenticated, scoped | |
| `GET /api/analytics/silent-workflows` | Workflows that went quiet | Authenticated, scoped | `?k=` sensitivity, 1.5–100 |
| `GET /api/workflows` | Workflow inventory, archived included | Authenticated, scoped | |
| `GET /api/analytics/organisation` | Folder/tag/project breakdown | Authenticated, scoped | Folder counts roll up through hierarchy |
| `GET /api/analytics/dependencies` | Blast radius — shared credentials/node types | Authenticated, scoped | Credential name/type only, never contents |
| `GET /api/analytics/deploys` | Version history vs. error onset | Authenticated, scoped | `?autosaves=true` to include autosave noise |
| `GET /api/analytics/metadata` | Business-metadata keys/values on executions | Authenticated, scoped | |
| `GET /api/analytics/node-profile` | Per-node timing profile | Authenticated, scoped | `?workflowId=` |
| `GET /api/analytics/system` | The dashboard's own pipeline health | Authenticated | `?brief=1`. Deliberately **not** elevated-only — anyone looking at a stale chart needs it |

---

## Alerts

Same router → `alertsController.js`. Reads are open to any authenticated
user; every write is **Elevated**.

| | Purpose | Auth | Notes |
|---|---|---|---|
| `GET /api/alerts/schema` | Rule/channel form vocabulary | Authenticated | Served, not duplicated in the frontend |
| `GET /api/alerts/status` | Whether alerting is currently paused | Authenticated | |
| `GET /api/alerts/rules` | List rules | Authenticated | |
| `POST /api/alerts/rules` | Create a rule | **Elevated** | |
| `PUT /api/alerts/rules/:id` | Update a rule | **Elevated** | |
| `DELETE /api/alerts/rules/:id` | Delete a rule | **Elevated** | |
| `GET /api/alerts/channels` | List channels | Authenticated | Secrets never returned |
| `POST /api/alerts/channels` | Create a channel | **Elevated** | |
| `PUT /api/alerts/channels/:id` | Update a channel | **Elevated** | |
| `DELETE /api/alerts/channels/:id` | Delete a channel | **Elevated** | |
| `POST /api/alerts/channels/:id/test` | Send a real test message | **Elevated** | Outbound network call |
| `POST /api/alerts/channels/parse-curl` | Parse a pasted `curl` command into fields | **Elevated** | Parsed only, never executed |
| `GET /api/alerts/channels/:id/curl` | Export a channel as `curl` | **Elevated** | Secrets masked |
| `GET /api/alerts/events` | Event history | Authenticated | `?limit=` 1–200, default 50 |
| `POST /api/alerts/run` | Run the alert pass now | **Elevated** | `?force=true` skips the staleness guard |
| `POST /api/fingerprints/:fingerprint/status` | Acknowledge / resolve / ignore an error group | Authenticated | Ordinary triage, not admin-only |
| `GET /api/fingerprints/:fingerprint/history` | Status-change history | Authenticated | |

See [../operations](../operations/README.md#alerting) for the full rule-type reference
and a step-by-step walkthrough.

---

## AI Chat

`src/routes/aiRoutes.js` → `aiController.js`. `aiLimiter` (5/min/user)
applies only to the two turn-starting routes — everything else here is
cheap by comparison and sits under the ordinary API limit.

| | Purpose | Auth | Notes |
|---|---|---|---|
| `POST /api/ai-chat` | Ask a question, non-streaming | Authenticated, scoped | Body: `message` (≤2000 chars), `conversationId?`, `tools?`. 503 if unconfigured |
| `POST /api/ai-chat/stream` | Same pipeline, as Server-Sent Events | Authenticated, scoped | 429 if a turn is already in flight for this user. See [../ai/developers.md](../ai/developers.md#the-sse-protocol) for the frame protocol |
| `GET /api/chat-history` | Messages for a conversation | Authenticated, scoped | `?conversationId=` |
| `GET /api/ai-chat/turns` | This user's in-flight turns | Authenticated, scoped | |
| `GET /api/ai-chat/turn/:id` | Reattach to a streaming turn | Authenticated, scoped | 404 (not 403) if not owned — avoids leaking existence |
| `POST /api/ai-chat/turn/:id/cancel` | Stop button | Authenticated, scoped | |
| `GET /api/ai-catalog` | `@`-mention autocomplete | Authenticated, scoped | `?q=` required, ≤120 chars. Under the ordinary limit, not `aiLimiter` — fires on every keystroke |
| `GET /api/ai-tag-options` | What `@`/`+` may offer | Authenticated, scoped | Reflects whether this user has connected the docs integration |
| `GET /api/ai-conversations` | List conversations | Authenticated, scoped | |
| `POST /api/ai-conversations` | Create a conversation | Authenticated, scoped | |
| `PATCH /api/ai-conversations/:id` | Rename a conversation | Authenticated, scoped | Final — the auto-naming pass never overwrites a manual rename |
| `DELETE /api/ai-conversations/:id` | Delete or archive | Authenticated, scoped | `?permanent=1` for a hard delete; default archives |
| `GET /api/ai-memories` | What the assistant remembers | Authenticated, scoped | |
| `DELETE /api/ai-memories/:id` | Forget one, or `:id = all` | Authenticated, scoped | No write endpoint — memories are only created by the assistant's own `remember` tool |

---

## Integrations

`src/routes/integrationsRoutes.js`, split into a public router (mounted
ahead of every authenticating router) and a private one.

| | Purpose | Auth | Notes |
|---|---|---|---|
| `GET /api/integrations/docs/callback` | OAuth return from the n8n docs service | **Public** | Security comes from a `state` bound to the initiating user, not a bearer token — the browser returning from the consent screen has none |
| `GET /api/integrations/docs` | This user's docs-connection status | Authenticated | Never returns a token |
| `POST /api/integrations/docs/connect` | Start the OAuth flow | Authenticated | Returns `{ url }` for the frontend to open in a popup |
| `POST /api/integrations/docs/disconnect` | Disconnect | Authenticated | |
| `GET /api/integrations/openai` | Assistant key/model status | Authenticated | Last 4 characters only, never the key |
| `POST /api/integrations/openai` | Save the OpenAI key | **Elevated** | Spends an owner's billing account |
| `POST /api/integrations/openai/clear` | Remove the stored key | **Elevated** | Falls back to `OPENAI_API_KEY` if set |

See [../integrations](../integrations/README.md) for the connection walkthroughs.
