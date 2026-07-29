# SEO Ecosystem Landing Pages — feedback / task checklist (2026-07-22)

From the Justin + Briant walkthrough (`Downloads/transcript (2).md`, §1 "SEO landing pages"). Refs
like `T:48` cite transcript line numbers.

Context: single TSX page + config/service files driving per-ecosystem SEO landing pages, plus an
Ecosystems **index** page. Featured models are the ones tied to the generator defaults; some content
(popular LoRAs, counts) is dynamically pulled, example generations are static (populated via a skill
that selects SFW models + SFW images per ecosystem). Goal: enough unique content per page to become
authoritative, keep it simple, and get picked up by Google. (`T:48–336`)

Tags: **[todo]** build · **[bug]** fix · **[content]** data/authoring · **[vNext]** later ·
**[question]** needs a decision (see Open Questions).

---

## Content / data on each page

- [x] **[content]** **Human fact-check list** — ✅ Produced: `docs/seo-ecosystem-fact-check.md`
  (tiers by risk + per-ecosystem flags; answers OQ1). Human still needs to *do* the verification. (`T:57–63`)
- [x] **[bug]** **Missing images** — ✅ Audited all 188 curated imageIds against the SFW/remixable
  rules: only **1** failed (a deleted image used as the Z-Image Base cover) — replaced with a valid
  SFW cover. All example imageIds pass remixability. (`T:81–85`)
- [x] **[todo]** **Show download AND generation counts** — ✅ Done. Cards now show both (↓ downloads,
  ⚡ generations), hidden when 0; engine models get a per-version generation fallback. (`T:86–90`)
- [ ] **[content]** **[question]** **Add release dates (in addition to "updated")** — deferred, needs a
  decision: (a) which date — the model's true external release date (external knowledge → fact-check
  risk) vs. "Added to Civitai" = the official model's `publishedAt` (DB-sourced, accurate); and (b)
  where to display it (the page doesn't currently surface `updatedAt` to users — it only drives the
  sitemap `<lastmod>`). Mechanism is easy once (a)/(b) are decided. (`T:199–208`)
- [x] **[todo]** **Mark ecosystems / base models as "new"** — ✅ Added `isNew?` config flag → renders a
  green "New" badge on the landing page hero + the /ecosystems index card. Set on the 4 freshly-added
  engines (Kling, Seedance, Grok, HappyHorse); toggle by hand per ecosystem. (`T:192–198`)

## Ecosystems index page

- [~] **[content]** **Add missing ecosystems** — 🟡 In progress. ✅ Added the 5 brand-name commercial
  models: **Nano Banana, Imagen 4, Seedream** (image) + **Veo 3, Sora 2** (video) — all grounded,
  simplified template, deep-links verified always-available (23 ecosystem pages total now).
  ✅ Also added **Chroma** (open Flux-based base model by Lodestone) — full template with a local-run
  box and auto-populated LoRAs (24 ecosystem pages total now).
  **Still to build** (buildable — have `EcosystemCheckpoints` + SFW media): **Ernie (243), Boogu (46),
  Mochi, Reve, Vidu**. **Skipped**: MAI (no always-available checkpoint) and Hailuo/MiniMax (0 models
  on-site). Same subagent-fan-out flow. (`T:169–171`)
- [ ] **[question]** **Dead / low-content ecosystems** — some listed ecosystems are effectively dead
  (e.g. Hyper). Decision for now: leave them and let creators come to us with questions rather than
  pre-emptively pruning/justifying inclusion. (`T:156–168`)

## Auto-generation for new ecosystems

- [ ] **[todo]** **Create these pages when a new ecosystem launches** — wire page creation into the
  add-ecosystem flow so new ecosystems (e.g. the recent "create 2") get a landing page (or at least a
  scaffold) automatically instead of by hand. (`T:186–194`)

## Discovery / internal linking (SEO authority)

- [x] **[todo]** **Update XML sitemap** — ✅ Done. `/ecosystems` index + every live page added to
  `sitemap-pages.xml`, each with a per-config `updatedAt` `<lastmod>`. (`T:224–231`)
- [x] **[todo]** **Link from model pages → ecosystem landing page** — ✅ Done. The **Base Model** value
  in model version details now links to `/ecosystems/<slug>` when a live page exists (resolved via
  `getBaseModelGroup(baseModel)` → `getEcosystemSeoPageForKey`). Justin's preferred spot. (`T:244–335`)
- [ ] **[todo]** **Marketing funnels** — add ways to funnel visitors from these pages into memberships
  or into generation; think about this pattern across the whole site, not just here. (`T:234–246`)

## Browse / filter behavior (already working — verify)

- [x] **[done? verify]** **Browse button sets base-model filters then purges the URL** — redirects to
  browse, sets the base-model filter, and cleans the URL after the initial load (passes the filter on
  first load only). Works; Briant calls it "a little hacky" but acceptable. (`T:127–142`)

## Tracking

- [ ] **[todo]** **Watch performance** — track views via Google Analytics + Search Console; decide
  whether to expand beyond the simple/most-popular set based on traffic. Note: overall site traffic /
  top search results appear down recently — worth confirming it's not affecting these pages. (`T:215–302`)

---

## Open questions (resolve before / during build)

1. ✅ **Fact-checking scope** — enumerated in `docs/seo-ecosystem-fact-check.md`. Tier 1 (verify):
   overview numbers + comparison ratings especially; Tier 0 (live DB data) is low-risk. (`T:57–63`)
2. ✅ **API-only versions** — **Anima has a page** (confirmed live in `ECOSYSTEM_SEO_PAGES`). Major
   generatable ecosystems still missing pages are listed under "Add missing ecosystems" above (Nano
   Banana, Seedream, Imagen 4, Veo 3, Sora 2, Reve, Vidu, Hailuo, …). (`T:273–283`)
3. ✅ **Counts scope** — confirmed correct. Stats + popular-LoRAs are scoped to each page's **own**
   declared ecosystem base models (`getEcosystemOwnBaseModels` across `key + additionalEcosystemKeys`),
   so no family bleed (e.g. Stable Diffusion excludes SDXL). Engine pages fall back to a media-created
   count where `ModelMetric` is empty. (`T:113–120`)
