# @civitai/mod-utils

Shared, **pure** moderation utilities used across apps (the main civitai app and the moderator spoke).

## The one rule: utils only

This package must stay **framework- and runtime-agnostic**:

- No DB, no `process.env`, no server-only imports, no network calls.
- No React / Svelte / Next — export **data and functions that return data**, never markup.

That purity is what lets any app import it anywhere — client or server, Next or SvelteKit. The moment
something needs env, a DB client, or a framework, it belongs in an app, not here.

## Contents

Root export (`@civitai/mod-utils`):

- `scanner-label-highlight-terms` — curated per-label term lists (`trigger` / `soft` / `carveOut`) for
  moderator-facing highlighting of scanner-audit content. These aid the eye only; they do **not** drive
  policy decisions.
- `scanner-label-policies` — the per-label policy text rendered beside those terms.
- `highlight` — `computeHighlightSegments(text, matchedTerms, label)` returns `{ text, source }[]` runs;
  each consumer renders its own `<mark>` using the shared `HIGHLIGHT_STYLES` color/weight data.

Subpath exports:

| Subpath | What it holds |
|---------|---------------|
| `./prompt-audit` | `getPromptHighlightSegments`, `includesInappropriate`, `normalizeText` — the audit surface the moderator spoke calls. |
| `./prompt-audit/lists` | The audit vocabulary as **named exports** (`blocked`, `blockedNSFW`, `poiWords`, `youngWords`, `harmfulCombinations`, `EXTERNAL_CLASSIFIER_REWRITES`, …). Import this barrel, never a `*.json` path — a raw JSON subpath export would be the only cross-workspace JSON import in the Next app. |
| `./prompt-audit/lists/ages` | The stated-age vocabulary (`ages`, `templates`, `templateParts`, `canonicalNumberWords`), post teen-expansion. |
| `./prompt-audit/word-regex` | `prepareWordRegex` / `prepareWordRegexBody` — the zero-width-boundary term-regex builder. Its ReDoS rationale lives in that file. |
| `./profanity/lists` | `blockedWords` / `whitelistWords` for `src/libs/profanity-simple`. |
