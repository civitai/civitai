# Ecosystem SEO Hub Pages

Programmatic-SEO landing pages, one per generation ecosystem (`/ecosystems/[key]` — Flux, SDXL, Pony, Illustrious, Wan, Qwen, …). Each page is the authoritative destination for high-intent search ("best Flux models", "Flux vs SDXL", "how to run Wan") and funnels visitors into the generator and membership.

Every page is built from the same template, populated with data only Civitai has: models, LoRAs, real generations, and usage metrics. That's the moat — nobody else can rank these pages with real numbers.

## The core split: generic (queried) vs. constant (curated)

The single most important design decision. Some data is **generic** — derivable per-ecosystem from a query, safe to show unattended. Some is **constant** — a human must curate it, because ranking surfaces the wrong thing.

> **Why this isn't optional.** Ranking Flux checkpoints by downloads returns `Flux.1-Dev NF4`, `GGUF Q4/Q5/Q8`, `Flux-Fill FP8` — technical quant repacks with `generationCount: 0`, because on-site generation runs on the _hosted_ standard model (id `618692`), not community checkpoint uploads. A "top checkpoints" query would fill the marquee slot with format dumps. Top **LoRAs** by downloads, by contrast, query beautifully. So checkpoints/featured images are curated; counts and LoRAs are queried.

| Data on the page                                      | Source                               | Cache          |
| ----------------------------------------------------- | ------------------------------------ | -------------- |
| Stat counts (models, images generated, LoRAs)         | **generic query**                    | Redis, 24h TTL |
| "Popular LoRAs" row                                   | **generic query** (top by downloads) | Redis, 24h TTL |
| Comparison-table peer counts                          | **generic query**                    | Redis, 24h TTL |
| **Featured models** (Flux.1 Dev / Krea / Kontext …)   | **curated constant**                 | in code        |
| **Featured example images + prompts**                 | **curated constant**                 | in code        |
| Hero copy, badges, attribution, FAQ, comparison peers | **curated constant**                 | in code        |

## Architecture

```text
GET /ecosystems/[key]                       (SSR via createServerSideProps)
  config  = ECOSYSTEM_SEO[key]              // curated constant; 404 if absent
  live    = getEcosystemSeoData(key)        // generic; Redis get/set, 24h TTL, fail-open → DB
  render(config, live)                      // + JSON-LD (FAQPage, BreadcrumbList)
```

- **Generic layer** — `src/server/services/ecosystem-seo.service.ts`. One `redis.get`/`set` with `EX: 24h`, JSON value, fail-open to a direct DB read on cache miss/outage (mirrors `getPopularCheckpointForEcosystem` in `services/blocks/checkpoint.service.ts`). Keyed `packed:caches:ecosystem-seo:<key>`. Queries filter to the ecosystem's whole **family** (`getFamilyBaseModels(key)` — every `baseModel` string under the key's `familyId`, so `/ecosystems/Flux1` covers Flux.1 + Flux.2 + Klein), not just the single ecosystem's base models. **Cache-bust:** append `?refresh=true` to the page URL to skip the cache read and recompute — gated to moderators (the page only passes `refresh` through when `session.user.isModerator`), so it can't be an anonymous stampede vector.
- **Constant layer** — `src/shared/constants/ecosystem-seo.constants.ts`. `ECOSYSTEM_SEO: Record<string, EcosystemSeoConfig>`. Adding an ecosystem = adding one entry (featured model IDs, image IDs, copy). Presence in this map is also the allow-list: a `key` with no entry 404s, so we launch pages deliberately, not all ~60 thin at once.
- **Page** — `src/pages/ecosystems/[key]/index.tsx`. SSR (not ISR) so counts are always the cached-fresh value and the HTML is fully populated for crawlers. Public + indexable (unlike `/generate`).

## NSFW exclusion (hard requirement)

No NSFW content renders on these pages — they're indexable and ad-safe.

- **Every generic query** filters `Model.nsfw = false` **and** `ModelMetric.nsfwLevel <= 1` (PG only). Model-level flag alone isn't enough; the metric-level `nsfwLevel` catches models that carry SFW flags but accumulated R+ imagery.
- **Featured images** are curated by ID, and **re-checked against `Image.nsfwLevel` at fetch time** — a later re-rating can't leak a now-explicit image onto a live page. An image that fails the check is dropped, not rendered.
- Featured model IDs are likewise re-validated (`nsfw = false`) on fetch.

## Featured checkpoints and the Generate CTA

A featured **checkpoint** only gets a "Generate" button if it's in the `EcosystemCheckpoints` table — those versions are always generatable, while every other checkpoint depends on auction results. `resolveFeaturedModels` marks the rest `generatable: false` and the card renders "View model" (a link to the model page) instead of a CTA that may not work. LoRAs aren't gated (they layer on top of an available checkpoint). That's how a canonical-but-unhosted release like Illustrious XL 1.0 can still be featured.

## Comparison-table LoRA counts are live

A comparison cell may hold a `{loras:Key}` token (`Key` = an `ECOSYSTEM_SEO` key), resolved at render time from `data.loraCounts` — the same query that feeds the hero stat, cached in the same 24h blob. **Always use the token for LoRA counts.** They were hand-written per page and drifted badly: Illustrious read 187K, 290K, or 294K depending on which page you were on, none of them matching its own hero stat. A token row also ignores the curated `winner` — the page highlights whichever column actually has the most.

## Sunsetting an ecosystem

When a hosted model gets an announced end-of-life, add `sunset: { date, note }` to its config. Before `date` the page shows a warning banner; from `date` on the banner switches to past tense, the page goes `noindex`, and it drops out of the sitemap — an SEO page that ranks for a model nobody can run is worse than no page. The `/ecosystems` index card shows a "Retiring" badge as soon as the field is set.

## The funnel — and the one real blocker

CTAs deep-link into the generator, pre-selecting the ecosystem: `/generate?modelVersionId=<featuredVersionId>`.

**Blocker:** `/generate` today (`src/pages/generate/index.tsx`) redirects logged-out users to login and is `deIndex`ed, and it does **not** parse `modelVersionId` from the URL — pre-selection happens client-side through the generation panel. So an anonymous visitor clicking "Generate" hits a login wall with no ecosystem primed. Two things needed before launch:

1. Have `/generate` read `?modelVersionId=` (or a new `?baseModel=<key>`) and prime the panel.
2. Confirm the login `returnUrl` round-trips back to that primed URL (search → page → generate → signup → generate).

Until then the CTA still works as a signup funnel, just without pre-selection.

## Adding an ecosystem

1. Add an `ECOSYSTEM_SEO[key]` entry (featured model/image IDs, hero copy, badges, FAQ, comparison peers).
2. Nothing else — the generic layer derives counts/LoRAs from the key's family (`getFamilyBaseModels`) automatically.
3. Verify the page at `/ecosystems/<key>`; the `.claude/skills/ecosystem-seo-page` skill can draft the constant entry and a visual mockup first.

**Video ecosystems** (Wan, Kling, LTXV, …): the config carries `modality: 'video'`; the page swaps "Example generations" → "Example videos", renders clips, and the settings line includes length/fps.

## Files

| File                                              | Role                                         |
| ------------------------------------------------- | -------------------------------------------- |
| `src/shared/constants/ecosystem-seo.constants.ts` | Curated per-ecosystem config + allow-list    |
| `src/server/services/ecosystem-seo.service.ts`    | Generic queries + 24h Redis cache            |
| `src/pages/ecosystems/[key]/index.tsx`            | SSR page                                     |
| `.claude/skills/ecosystem-seo-page/`              | Skill: drafts a config entry + visual mockup |
| `docs/working/ecosystem-seo/flux.html`            | Static design reference (real Flux data)     |
