# Database

*What `dashboard.sqlite` actually contains: what's mirrored from n8n, what
exists only here, and the read-only views that are the AI assistant's entire
world. Built from `src/config/schema.js` directly — every table below is
real, and the migration id in brackets is where to find it.*

The schema is an ordered list of migrations recorded in
`schema_migrations`, each in its own transaction, idempotent, so an existing
replica upgrades in place and a failed migration stops the process rather
than leaving the schema in a state nobody described. See
[../architecture](../architecture) for how migrations fit into the boot
sequence, and [../operations](../operations) for backup/restore and
retention.

---

## 1 · Mirrored from n8n

The replica takes a **narrow slice** of n8n's schema — metadata columns only,
never workflow definitions, never credential contents, never payloads. What
column is skipped is usually as deliberate as what's kept, and the schema
comments say why; the table below carries that reasoning forward.

### `workflow_entity` `[001]` `[009]` `[010]`

| Column | Since | Why |
|---|---|---|
| `id`, `name`, `active` | 001 | The four this dashboard started with |
| `isArchived` | 009 | 87 of 163 workflows on the instance this was built against are archived — "more than half the dropdown was dead entries" without it |
| `parentFolderId` | 009 | n8n's folder hierarchy, previously flattened away |
| `createdAt`, `updatedAt` | 009 | Distinguishes "died silently" from "somebody turned it off," and keeps a brand-new workflow from reading as broken |
| `triggerCount` | 009 | n8n's own opinion on whether a workflow is meant to run unattended |
| `description` | 009 | |

### `execution_entity` `[001]` `[002]` `[009]` `[008]` `[010]`

n8n's own table has 19 columns; the replica takes 14 of them.

| Column | Since | Why |
|---|---|---|
| `id`, `workflowId`, `status`, `startedAt`, `stoppedAt` | 001 | Base |
| `missing_since` | 001 | Set the first cycle Postgres stops returning a still-non-terminal row; promoted to status `unknown` after a grace period instead of staying "running" forever |
| `analytics_status`, `analytics_attempts`, `analytics_next_attempt` | 002 | Makes error-detail extraction resumable across cycles rather than best-effort within one |
| `mode` | 009 | Webhook / schedule / manual / retry / integrated / CLI — a webhook failing at 4.0% and a schedule failing at 1.1% are different problems; one blended rate describes neither |
| `createdAt` | 009 | Paired with `startedAt` to measure queue lag — a different question from throughput |
| `waitTill` | 009 | Set by a Wait node; distinguishes "parked on purpose" from "stalled" |
| `finished` | 009 | Distinct from `status` |
| `retryOf`, `retrySuccessId` | 009 | The retry graph — a failure that succeeded on retry stops reading as an outage |
| `jsonSizeBytes`, `binaryDataSizeBytes` | 009 | Feeds the storage forecast |
| `workflowVersionId` | 009 | Pairs with `workflow_history` — error rates compared across versions of the same workflow |

**Left out on purpose:** `deletedAt` — every fetch already filters soft-deleted
rows, so the column would always read NULL, "which reads like an answer."
`storedAt`, `deduplicationKey`, `tracingContext`, `usedPrivateCredentials` —
n8n 2.x internals with no consumer here; a mirrored column costs a write on
every row forever, so it has to earn that cost.

### `execution_error_analytics` `[001]` `[002]` `[011]` `[008]` `[012]`

Not a 1:1 mirror — this is the ETL's own structured extraction from a failed
execution's payload.

| Column | Since | Notes |
|---|---|---|
| `node_name`, `node_type`, `error_type`, `error_message`, `error_stack`, `source_node`, `source_output_index`, `input_data`, `metadata`, `execution_source` | 001 | See [../security](../security) for why three of these never leave this table |
| `error_category` | 001 | `rate_limit`, `auth`, `network`, `config`, `data`, `logic`, `upstream`, `unknown` |
| `http_code` | 002 | Read from n8n's own error object — more reliable than regexing "429" out of free text; NULL on historical rows |
| `fingerprint` | 011 | Links to `error_fingerprints` — the mechanism that collapsed 14,271 raw errors into 98 real units of work |

### `workflow_statistics` `[013]`

The one source that **survives n8n's own pruning**: a counter, not a row, so
a workflow whose entire execution history has aged out of `execution_entity`
still reports when it last ran. `PRIMARY KEY (workflow_id, name)` where
`name` is n8n's own event name (`production_success`, `production_error`,
`manual_success`, `manual_error`, `data_loaded`).

### Organisation & structure `[014]` `[015]`

| Table | Mirrors | Notes |
|---|---|---|
| `folder` | n8n's folder hierarchy | `parent_folder_id` for rollups |
| `tag_entity` / `workflows_tags` | n8n tags | |
| `workflow_history` | Version history, **metadata only** | `nodes`/`connections` explicitly excluded — mirroring the actual workflow definition "would turn a metadata replica into a copy of the customer's intellectual property for no gain" |
| `workflow_dependency` | Derived from node/credential/webhook relationships | One row per (workflow version, thing it depends on) — the blast-radius feature. Carries an id/type reference only; "the credential contents are nowhere near this table" |
| `credentials_entity` | Metadata only | The `data` column — the encrypted blob — is the one column excluded from this entire table |
| `execution_metadata` | Business key/value pairs a workflow wrote | Values capped at 512 chars to match n8n's own limit; mirroring values at all is optional (`SYNC_METADATA_VALUES`) |

### Authorization mirror `[004]`

`project`, `project_relation`, `shared_workflow` — mirrored, not queried live,
because every scoped read joins against it and a Postgres round-trip per
request would put n8n's own database on the critical path of every page
load. See [../security](../security#who-sees-what) for why this is
re-synced wholesale every cycle rather than incrementally.

Deliberately **no foreign keys** back to `workflow_entity`: membership is
replaced wholesale each sync, and a workflow deleted mid-sync would otherwise
abort the whole replacement and leave stale membership in place. An orphaned
id "simply joins to nothing, which is the correct outcome anyway."

---

## 2 · Dashboard-owned tables

Nothing in this section exists in n8n. Grouped by what they're for.

**Identity & settings**

| Table | Migration | Purpose |
|---|---|---|
| `users` | 001 | Local mirror of dashboard-authenticated users (`id`, `email`) — upserted on login, the row every `user_id` foreign key below points at |
| `dashboard_settings` | 001 | Non-secret key/value settings, served wholesale to any authenticated page |
| `dashboard_secrets` | 024 | Secrets, split into their own table on purpose — see [../security](../security#secrets) |
| `workflow_settings` | 001, 002, 026 | Per-workflow ROI inputs: `saved_time_seconds` and `hourly_rate`, plus the four `baseline_*` columns holding the manual job that figure was derived from. The division is one-way, so storing only its result would leave the Business case view unable to redisplay what anybody actually claimed. All four NULL means the figure was typed directly |

**The AI assistant** — see [../ai](../ai) for how these are used

| Table | Migration | Purpose |
|---|---|---|
| `dashboard_chat_conversations` | 022, 025 | One row per thread. `summary`/`summarised_until` are dead columns — the fold that used them was removed because it discarded the record of which analysis produced which number; kept only because editing a shipped migration is the mistake this whole system exists to prevent. `title_generated` records whether the title was model-written or a manual rename, so an auto-naming pass can never overwrite a name a person chose |
| `dashboard_chat_history` | 001, 022, 023 | Individual messages; `conversation_id` nullable only for rows written before conversations existed |
| `dashboard_user_memories` | 022 | Small, user-visible, user-deletable notes, written only through an explicit tool call — a unique index on `(user_id, lower(content))` dedupes near-repeats |
| `integration_credentials` | 021 | OAuth tokens for external services (currently: the n8n docs lookup). `user_id` nullable = "this deployment" owns the credential |

**Alerting** — see [../operations](../operations#alerting)

| Table | Migration | Purpose |
|---|---|---|
| `alert_rules` | 016, 017 | A standing question, evaluated every cycle — one generic shape rather than seven near-identical tables, "which would be seven places to forget the cooldown" |
| `alert_channels` | 016 | Delivery destination; `config` is JSON and can hold secrets, always redacted on the way out |
| `alert_events` | 016, 017 | Every firing, including suppressed and failed ones — "why was I not told" has to be answerable after the fact |
| `fingerprint_events` | 016, 017 | Audit trail of acknowledge/resolve/ignore/reopen decisions on an error group |

**Operational self-knowledge**

| Table | Migration | Purpose |
|---|---|---|
| `sync_runs` | 007 | One row per ETL pass — duration, rows read, errors extracted, replica size. The direct answer to "when did this last succeed" |
| `instance_lock` | *(owns its own schema — not in `schema.js`)* | The single-writer election; see [../architecture](../architecture#single-writer-election) |
| `rate_limits` | 006 | Rate-limit counters, stored in the replica so a restart or a second instance never hands out a fresh allowance |
| `error_fingerprints` | 011 | One row per normalized error group. Deliberately holds **no counts** — those are derived at read time from `execution_error_analytics`, so there is never a second, driftable source of truth |

**Node & edge profiling** (F-12)

| Table | Migration | Purpose |
|---|---|---|
| `workflow_node_profile` | 018, 019 | Per-node timing sample, replaced wholesale per workflow each pass — never blended across eras |
| `workflow_profile_state` | 018, 019 | Watermark of when each workflow was last profiled |
| `workflow_edge_profile` | 020 | Item counts crossing each edge — deliberately not framed as "data loss": a rollup node reducing 5,763 items to 122 is doing its job |

---

## 3 · The `ai_*` views

`src/config/aiViews.js`, built as `TEMP VIEW`s on a second connection opened
`OPEN_READONLY` (`src/config/readonlyDb.js`). This is the AI assistant's
**entire** read surface — nothing outside this list is reachable from a
model-generated query, `run_sql` included.

| View | Reads | Notably omits |
|---|---|---|
| `ai_workflows` | `workflow_entity` (scoped) | — |
| `ai_executions` | `execution_entity` (scoped) | Precomputes `duration_seconds` so the model doesn't recompute it (and doesn't get it wrong) from raw timestamps |
| `ai_errors` | `execution_error_analytics` (scoped) | `error_message`, `error_stack`, `input_data`, `metadata` — entirely absent from the view definition, not filtered at read time |
| `ai_error_groups` | `error_fingerprints` + `ai_errors`, joined against a rebuilt TEMP TABLE of computed labels | `sample_message` and `normalized_message` — the latter looks masked but isn't (only numbers/dates are replaced); a derived, truncated `error_label` is computed in JS instead, cut at the first structural delimiter and capped at 80 characters |
| `ai_folders`, `ai_projects`, `ai_tags`, `ai_workflow_tags` | The matching mirror tables | — |
| `ai_deploys` | `workflow_history` (scoped) | The actual workflow definition, obviously — this view never had it to begin with |
| `ai_node_profile`, `ai_dependencies` | The matching profile/dependency tables (scoped) | — |
| `ai_workflow_settings` | `workflow_settings` (scoped) | — |
| `ai_metadata_keys` | `DISTINCT key` from `execution_metadata` | **Values.** Explicitly: "the values are customer identifiers and are not exposed" |
| `ai_sync_runs` | `sync_runs` | Lets the assistant know when to distrust its own numbers |

**Never exposed to any `ai_*` view, by construction**: `input_data`,
`error_stack`, `error_message`, `error_fingerprints.sample_message`,
`users` (password hashes), `credentials_entity` (though the base table never
stored credential material anyway), `dashboard_chat_history` (other users'
conversations), `execution_metadata.value`. See
[../security](../security#the-ai-assistants-sandbox-briefly) for the
enforcement layering around this list.

Scoping is enforced *inside* every workflow-derived view via a temp table
(`ai_scope`) repopulated per request — a subquery or `UNION` against a scoped
view is still working against the already-filtered relation, so there is no
arrangement of `SELECT` that reads underneath it.

---

## 4 · Indexes with a reason worth knowing

Most indexes are the ordinary kind — this table only lists the ones whose
existence (or shape) answers a question you might otherwise ask.

| Index | On | Why |
|---|---|---|
| `idx_exec_analytics_pending` | `execution_entity(analytics_next_attempt, id)` **partial**, `WHERE analytics_status = 'pending'` | The analytics queue is a handful of rows out of half a million; only the pending ones are ever queried |
| `idx_exec_retry_of` | `execution_entity("retryOf")` **partial**, `WHERE "retryOf" IS NOT NULL` | The column is NULL on nearly every row — a full index would be half a million entries serving none |
| `idx_integration_deployment` / `idx_integration_user` | `integration_credentials` **partial unique** | SQLite treats every NULL as distinct, so a plain `UNIQUE(provider, user_id)` would let the same deployment-level credential be stored endlessly |
| `idx_memories_unique` | `dashboard_user_memories(user_id, lower(content))` **unique** | Case-folded, because a model repeating an idea in slightly different words shouldn't create a second memory |
| `idx_chat_conversation` | `dashboard_chat_history(conversation_id, id)` | The pre-existing `(user_id, created_at)` index can't answer "this conversation, oldest first" — it orders across every conversation a user has |
| `idx_node_profile_ms` | `workflow_node_profile(total_ms DESC)` | Serves "slowest nodes anywhere," read in the opposite order from the table's own primary key |
| `idx_alert_events_key` | `alert_events(dedupe_key, fired_at)` | The cooldown check, once per candidate alert per cycle: "given this key, when did it last fire" |
| `idx_exec_mode_started` | `execution_entity(mode, "startedAt")` | Trigger-type analytics filters and groups by both, over a time range, on every load |

Two indexes are **transient scaffolding**, not permanent schema:
`idx_exec_backfill_pending` and `idx_err_fp_pending` exist only to speed up
one-time backfills and are dropped by the sync job once each backfill
completes — registered as such so the offline optimizer never recreates them.

`INDEX_STATEMENTS`, exported from `schema.js`, is *derived* by scanning every
migration for `CREATE INDEX` statements rather than hand-maintained
separately — the index set used to drift out of sync with what the app
actually created, by five indexes, before this became mechanical.

---

## Working with the replica directly

```bash
sqlite3 dashboard.sqlite "PRAGMA integrity_check;"          # structural validity only
sqlite3 dashboard.sqlite "SELECT COUNT(*) FROM execution_entity;"
```

See [../deployment](../deployment#backup-restore-and-verification) for
backing up, restoring into a fresh volume, and verifying a copy is both
structurally sound *and* complete — `integrity_check` alone proves the
first, not the second.
