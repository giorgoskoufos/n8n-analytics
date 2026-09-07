## What this changes and why

<!-- One or two sentences. Link an issue if there is one. -->

## Checklist

- [ ] `npm run check` passes (lint + the full test suite)
- [ ] `npm run build:css` run and committed, if any HTML/JS classnames or `input.css` changed
- [ ] `node src/scripts/vendorAssets.js` run and committed, if a browser-shipped dependency changed
- [ ] `documentation/` updated, if this changes behaviour it describes
- [ ] `CHANGELOG.md` `[Unreleased]` section updated, if this is user-visible

## Breaking changes

<!--
An env var removed/renamed, the alert payload `source` field, an /api/*
response shape someone might script against, a manual migration step, or a
raised minimum n8n/PostgreSQL version. "None" is a fine answer.
-->
