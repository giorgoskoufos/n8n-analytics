# Frontend

*Vanilla JS, no framework, no bundler, no build step — except Tailwind, which
is compiled. If you've only worked in React/Vue/Svelte before, the mental
model here is closer to jQuery-era multi-page apps: every page is a real
HTML file, every script is a real `<script>` tag, and "state" mostly
lives in the DOM.*

Why no bundler: it means `npm install` and a browser are the entire toolchain
— no webpack config to keep alive, no build to break silently, no version of
Node that a bundler plugin secretly requires. The tradeoff is explicit script
ordering (below) instead of automatic dependency resolution, and it's a
tradeoff this project has made on purpose, not by not-getting-around-to-it.

---

## Pages

Every page in `public/pages/*.html` follows the same shape: a `guard.js`
script in `<head>` (the one exception is `login.html`, which must be
reachable unauthenticated), then a body, then a fixed sequence of scripts at
the bottom.

| Page | What it is |
|---|---|
| `public/index.html` | The main dashboard — KPI cards, three Chart.js charts, an infinite-scroll execution table |
| `pages/login.html` | Email/password form, posts to `/api/login`, stores the JWT |
| `pages/insights.html` | Trigger types, queue lag, concurrency, reliability, storage, business metadata — split into lazily-loaded views |
| `pages/errors.html` | Error Intelligence — grouped/fingerprinted errors, category breakdown, drill-down |
| `pages/alerts.html` | Alert rules and channels, form generated from a server-provided schema |
| `pages/roi.html` | ROI — Overview and Configure tabs, tab state kept in the URL hash |
| `pages/settings.html` | General settings, the assistant's model/key, the docs integration, memory viewer, pipeline health |
| `pages/chat.html` | The full-page assistant — same engine as the floating panel, larger surface, full history replay |

**`public/global-header.html`** is not included via a `<script>` tag or
a server-side include — it's markup-only, holding two `<template>`
elements (the sidebar rail, the per-page title/breadcrumb slot). `logic/header.js`
fetches it at runtime, clones the templates into the live DOM, and moves the
page's own existing body content into a `.shell-main` wrapper. One file, one
shared shell, injected identically on every page — the fix for what used to
be six copies of the same sidebar markup, independently drifting.

---

## `public/logic/` — what owns what

**Shell & auth**

| File | Owns |
|---|---|
| `logic/guard.js` | Redirects to login if there's no token. Exposes `window.fetchWithAuth` — see below |
| `logic/header.js` | Assembles the shell: fetches `global-header.html`, injects the sidebar, wires collapse/drawer behaviour, polls health/sync-lag status pills, injects the floating assistant unless `body[data-assistant="off"]` |
| `logic/login.js` | The login form |

**Shared utilities** — the layer that exists specifically so six pages don't reinvent the same helper six times

| File | Owns |
|---|---|
| `logic/global_functions.js` | `escapeHtml` (mandatory before any `innerHTML`), `formatTime`/`formatMoney`/`formatDuration`/`currencySymbol`, the `data-action` click dispatcher, `initSettings` |
| `logic/ui/components.js` | `window.UI` — cards, tables, badges, modals, empty/loading/failed states |
| `logic/ui/viz.js` | One Chart.js theme, read from CSS custom properties, so every chart looks and behaves the same |
| `logic/ui/sync-progress.js` | The "still catching up on initial sync" banner |
| `logic/error-modal.js` | The execution-snapshot and node-timing trace modals |

**The `data-action` dispatcher deserves its own mention.** Every click handler
in this codebase is `data-action="doThing"` plus a registered function,
never an inline `onclick=`. That's not a style preference — it's what makes
the CSP's `script-src-attr 'none'` (see [../security](../security/README.md)) possible
at all. Adding a new interactive element means adding to this registry, not
writing `onclick=`.

**Per-page logic**, one folder per feature area:

- `logic/app/` — the main dashboard, split into `_globals`, `_chart_initialization`,
  `_data_fetching`, `_ui_updaters`, `_infinite_scroll_table`,
  `_tab_navigation___dynamic_tables` — loaded in order by `logic/app.js`.
- `logic/chat/` — `store.js` (persists history/turn-id across page loads),
  `render.js` (markdown via `marked` + `DOMPurify`), `tags.js` (the `@`
  mention layer), `panel.js` (the floating panel shell). `logic/chat-core.js`
  is the actual engine — send/stream/attach — shared between the floating
  panel and `pages/chat.html`.
- `logic/settings/` — one file per settings section (`_fetch`, `_save`,
  `_nav`, `_system`, `_integrations`, `_ai`, `_memory`), loaded in order by
  `logic/settings.js`.
- `logic/roi/` — `roi_overview.js`, `roi_config.js`, and `roi_math.mjs`. The
  Configure tab has two mutually exclusive views of the same setting —
  **Business case** (describe the manual job; the default) and **Per-run
  figures** (type the number) — chosen once for the whole list and remembered
  in `localStorage`. `roi_math.mjs` is a **pure** calculation module
  (human-time-per-month ÷ measured executions → seconds saved), deliberately
  isolated so it can be unit-tested without a DOM, and its period/unit lists
  are asserted against the server's validator so a storable baseline is always
  a computable one.
- `logic/alerts.js`, `logic/errors.js`, `logic/insights.js` +
  `logic/insights_nav.js` — one page each. `insights_nav.js` exists
  specifically to split what used to be an 11-panel, 1128-line file into four
  lazily-loaded views with deep-linkable `#panel=` anchors.

---

## The auth guard and the API-call convention

`guard.js` runs on page load, before anything else: if there's no token in
`localStorage`, it `location.replace`s to the login page immediately, so a
protected page never gets a chance to render meaningfully without one.

It also defines **`window.fetchWithAuth(url, options)`** — the one function
every page uses instead of raw `fetch` for anything under `/api/*`. It:

1. Attaches `Authorization: Bearer <token>` and
   `Content-Type: application/json`.
2. On a `401`, clears the token and redirects to `login.html?reason=expired`
   (de-duplicated so a page with several in-flight requests doesn't fire the
   redirect five times), then throws `"Session expired"`.
3. On a `403`, does **not** treat it as an auth failure — the response is
   returned as-is, so the caller can show the server's own explanation (e.g.
   *"Only an owner or admin can change alerting"*) instead of bouncing to
   login for a permission problem that logging in again can't fix.

There is no single global error-toast system. Each page handles a failed
call the way that page's UI calls for — inline error text
(`settings_save.js`, `login.js`), a muted status pill (`header.js`'s
health/sync indicators), or a friendly fallback string in a modal
(`error-modal.js`).

---

## CSS

- `public/css/input.css` — the Tailwind v4 **source**. Not just utility
  classes: a heavily-commented design-token layer defines the color system
  (mark/ink pairs chosen for contrast), a validated categorical palette for
  charts, and reserved status colors. **Edit this file.**
- `public/css/styles.css` — the **built, minified output**. Generated, never
  hand-edited.

```bash
npm run build:css     # one-shot
npm run watch:css     # rebuilds on change, for local development
```

---

## Vendor assets — nothing from a CDN

`public/vendor/` holds committed copies of Chart.js, `marked`, DOMPurify,
Font Awesome, Open Sans, and a custom-built `highlight.js`. This isn't an
oversight waiting for a CDN link — it's the enforcement mechanism behind the
CSP's `script-src 'self'` (see [../security](../security/README.md#frontend-hardening)):
Chart.js and `marked` used to load from jsDelivr with no pinned version,
which meant a third party could change the code running in a page holding an
auth token, and a breaking upstream release could take the dashboard down
with zero warning here.

Two scripts populate the folder — run manually, not part of `npm install`,
because the Docker build copies source in *after* `npm install` and a
postinstall hook can't reach `public/` at that point:

```bash
node src/scripts/vendorAssets.js   # Chart.js, marked, Font Awesome, Open Sans
npm run build:hljs                 # highlight.js — it ships no browser bundle on npm,
                                    # so this concatenates the core + a narrow language
                                    # subset (sql, json, javascript, python, bash, yaml)
                                    # into one IIFE
```

The output is committed on purpose. Bump a version in `package.json`, run
both scripts, commit the result.

---

## Adding a page

There's no scaffolding command — copy the shape of an existing page that's
closest to what you're building:

1. New HTML file in `public/pages/`, `guard.js` in `<head>`.
2. A `logic/<yourpage>.js` (or a folder, if it's big enough to split).
3. Script order at the bottom: `global_functions.js`, `ui/components.js`,
   then your page's own script(s), then `ui/sync-progress.js`,
   `header.js` last — `header.js` needs the page's own DOM already in place
   to move it into `.shell-main`.
4. Add a nav entry to the `#tpl-shell-nav` template in
   `public/global-header.html`.
5. Use `window.fetchWithAuth` for every API call, `UI.*` for any card/table/
   modal you'd otherwise be tempted to hand-roll, and `data-action="..."` for
   every click handler — never `onclick=`.
