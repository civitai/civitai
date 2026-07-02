# @civitai/mod-utils

Shared, **pure** moderation utilities used across apps (the main civitai app and the moderator spoke).

## The one rule: utils only

This package must stay **framework- and runtime-agnostic**:

- No DB, no `process.env`, no server-only imports, no network calls.
- No React / Svelte / Next — export **data and functions that return data**, never markup.

That purity is what lets any app import it anywhere — client or server, Next or SvelteKit. The moment
something needs env, a DB client, or a framework, it belongs in an app, not here.

## Contents

- `scanner-label-highlight-terms` — curated per-label term lists (`trigger` / `soft` / `carveOut`) for
  moderator-facing highlighting of scanner-audit content. These aid the eye only; they do **not** drive
  policy decisions.
- `highlight` — `computeHighlightSegments(text, matchedTerms, label)` returns `{ text, source }[]` runs;
  each consumer renders its own `<mark>` using the shared `HIGHLIGHT_STYLES` color/weight data.
