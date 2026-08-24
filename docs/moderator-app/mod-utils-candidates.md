# `@civitai/mod-utils` — migration candidates

> **Two in-app duplications collapsed 2026-08-21**, neither a `mod-utils` candidate — recorded here
> because this is where "a second copy was written instead of shared" gets tracked.
>
> - **The refusal banner** was hand-rolled at 38 sites across 30 files, identical but for the margin.
>   Now `$lib/components/ErrorAlert.svelte`; 36 converted. The two left are nested *reason* panels
>   rather than refusal banners. It reproduces the existing markup EXACTLY rather than adopting
>   `@civitai/ui`'s `alert` primitive — that has its own padding, structure and palette, so swapping to
>   it would restyle 38 messages in one pass, a visual change wearing the clothes of a refactor.
>   Collapsing the copies is what makes that a single edit if someone decides to take it.
> - **The `/retool/*` path builders** existed twice — `src/shared/constants/moderator-app.ts` and
>   `$lib/entity-url.ts` — each with a comment telling the reader to keep them in step, and already
>   diverged on whether user-lookup takes a `section`. Now `@civitai/shared/moderator-paths`, imported
>   by both. That namespace is documented as transitional, so the copy nobody updated when it moves is
>   the one that becomes a dead link.


A running list of moderation logic that should move into the shared **`@civitai/mod-utils`** package
(`packages/civitai-mod-utils`) as the moderator-app migration proceeds. When porting a page surfaces a
pure moderation constant/util that is (or will be) shared between the main app and the spoke, **add a row
here** rather than silently re-authoring a second copy in the spoke.

## The rule (why things qualify)

`@civitai/mod-utils` is **utils only** — framework- and runtime-agnostic:

- ✅ pure data + functions that return data; usable on client or server, in Next or SvelteKit.
- ❌ no DB, no `process.env`, no server-only imports, no React/Svelte, no network calls.

If a util needs env/DB/framework, it stays in the app. Tailwind **class strings** are fine (they're just
data), but anything that imports a component or a client is not.

## Process

1. Porting a page, you find a pure moderation util duplicated across apps (or about to be) → add a row below.
2. Move it deliberately in its **own scoped change**. A move that also touches the main app (re-pointing its
   imports) is its own PR-sized unit — not folded into an unrelated page port, and not a bulk sweep.
3. Wiring reminder: `workspace:*` dep in `apps/moderator/package.json` + add the name to `ssr.noExternal` in
   `vite.config.ts`, then `pnpm install`.

## Candidates

| Util | Main-app source | Spoke copy | Pure? | Status | Notes |
|------|-----------------|-----------|-------|--------|-------|
| Scanner highlight terms + `computeHighlightSegments` / `HIGHLIGHT_STYLES` | (deleted) `shared/constants/scanner-label-highlight-terms` | — | ✅ | **Moved** | First occupant. Term lists + framework-agnostic segment computer. |
| Browsing levels — `NsfwLevel`, `browsingLevels`, `getBrowsingLevelLabel`, `validNsfwLevels`, `ingestionErrorLevels` | `src/shared/constants/browsingLevel.constants.ts` (still a second copy; `NsfwLevel` from `~/server/common/enums`) | `@civitai/shared` — `packages/civitai-shared/src/browsing-levels.ts` | ✅ | **Spoke done; main app not repointed** | The spoke no longer has a copy: it imports all five from `@civitai/shared` (`nsfw-levels.ts`, `ImageQueueGrid.svelte`, `articles/ratings/+page.svelte`, `article-rating-review-actions.ts`). What is left is repointing the main app's imports at the shared package and deleting its duplicate — its own scoped change. **Not a `mod-utils` candidate**: these are browsing levels, not moderation utils, and `@civitai/shared` is already their home. The earlier entry named `apps/moderator/src/lib/browsing-levels.ts`; no such file exists. |
| Scanner-audit verdict/mode helpers — `verdictFromAnswer`, `verdictShort`, `verdictClass`, `VERDICT_ORDER`, `SCANNER_MODES`, `modeToScanner`, `isValidMode` | (deleted with scanner-review) | `apps/moderator/src/lib/scanner-audit.ts` | ✅ (class strings ok) | **Hold** | Spoke-only today (main-app scanner-review was removed in this migration). Move only if a second app needs them. `ReviewVerdict` enum itself comes from the DB-schema enums, not here. |
| Scanner label regex specs — `SCANNER_LABEL_REGEX` (familial, nonconsent-keyword, diaper, menstruation, scat, urine, bestiality) `triggers`/`phrasePatterns`/`carveOutPatterns` | `src/server/services/scanner-label-regex.ts` (still used by the main-app scanner) | — | ✅ (data is pure; detector fns too) | **TODO** | The per-label term source for highlighting. Only `young` (an XGuard label) has hand-curated highlight terms today, so regex labels highlight nothing from policy. Share the specs here, repoint the main-app scanner's import, and feed `triggers` into `computeHighlightSegments`. `triggers` are literal words (easy); `phrasePatterns`/`carveOutPatterns` are regex (need pattern-aware highlighting). Genuinely shared (scanner + spoke) → strong fit. |

Add rows as new shared utils surface (cosmetic-type humanization, report-reason maps, bitwise-flag helpers, …).
