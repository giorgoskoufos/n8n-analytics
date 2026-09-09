# Changelog

All notable changes to this project are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

For a self-hosted app the version contract is about **upgrade safety**:

| Bump | Means |
|---|---|
| MAJOR | An environment variable removed or renamed, an alert payload field changed, a manual migration step, or a raised minimum n8n / PostgreSQL version |
| MINOR | New features, new optional settings, new endpoints. A safe `docker compose pull`. |
| PATCH | Fixes only. Always safe. |

## [Unreleased]

## [2.0.0] — 2026-09-09

### Added

- **Alerting.** Seven rule types — a failure nobody has seen before, error rate,
  silent death, queue lag, volume drop, payload spike and replica growth —
  delivered over an outgoing webhook, an n8n workflow, or Telegram.
- **Insights** page: queue lag (p50/p95/p99) with a backpressure signal,
  trigger-type breakdown, and reliability analytics.
- **Silent death detection** — active workflows that quietly stopped running,
  which n8n itself does not report.
- **AI analytics assistant**, rebuilt around tool calling: it answers by
  invoking the dashboard's own analyses rather than by inventing numbers, and
  shows its working. Optional, and off until you add an OpenAI key in Settings.
  It can also write read-only SQL against a restricted set of views — see
  Security below, and `AI_SQL_TOOL=off` to disable that specific capability.
- `GET /api/version`, reporting version, commit and Node version. Unauthenticated,
  because the person who most needs it is often the one who cannot log in. Also
  shown in **Settings → Health**, and stamped onto the image as OCI labels.
- `docker-compose.yml` and `docker-compose.build.yml` at the repository root,
  and a published multi-architecture image on GHCR — running this no longer
  requires cloning it.

### Changed

- **Backend restructured** into routes → controllers → DAOs. All database access
  now goes through a DAO layer with shared scoping, rather than through
  controllers directly.
- Frontend refactor: a shared component layer, one Chart.js theme, and a strict
  Content-Security-Policy with no inline event handlers anywhere.
- **The project has one name: `n8n-analytics`.** It previously answered to three
  (`n8n-metrics-dashboard`, `n8n-analytics-dashboard`, `n8n-analytics-v2`)
  depending on where you looked.
- The GitHub repository was renamed from `n8n-metrics-dashboard`. GitHub keeps a
  permanent redirect, so existing clones, forks and links continue to work.

### Fixed

- The execution-volume chart is populated before the first sync finishes. Its
  series is cached by the ETL, so on a fresh install — or after a replica
  rebuild — there was nothing to read and the panel rendered blank with no
  explanation. It now computes the same buckets live until the cache exists.

### Security

- The assistant runs against a read-only SQLite connection over purpose-built
  `ai_*` views. Columns holding execution payloads are not merely filtered out
  of those views — they are absent from them.
- Alert targets are validated against SSRF, including cloud metadata endpoints.

### Notes for upgraders

- **Not a breaking change, despite the major bump.** 2.0.0 reflects the size of
  the change, not a broken contract: no environment variable was removed or
  renamed, and migrations are ordered and idempotent as before.
- **Alerting is new**, so the `source` field on alert payloads
  (`"source": "n8n-analytics"`) has no prior contract to break. From 2.0.0 it is
  a stable interface — people build n8n filters on it, so changing it later
  would be a MAJOR bump.
- **Downgrading is not supported** once a migration has run. Back up the `/data`
  volume before upgrading.

## [1.0.0] — 2026-08-22

The public v1, as published to `n8n-metrics-dashboard`. Tagged retroactively at
`346bc2c`, the last commit before v2 work began.
