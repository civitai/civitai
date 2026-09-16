# SEO Improvements — What To Build

A ranked list of work that would improve how civitai.com and civitai.red rank, and what should
deliberately *not* be built. Companion to [seo-audit.md](seo-audit.md), which is the per-page
posture reference; this doc is the backlog.

Started 2026-09-15, from a Search Console video-indexing error that turned into a coverage review.

> **This repo is public.** Absolute Search Console figures — click and impression totals, indexed
> page counts — are deliberately not reproduced here; they are business metrics a competitor cannot
> otherwise observe. Ratios and structural findings are kept, because they are what the decisions
> below rest on and they leak nothing useful. Pull a current export rather than trusting a figure
> written down months ago.

---

## The premise, corrected

The review opened by assuming three things were wrong. Measurement killed all three, and the
record is kept here so they are not re-opened:

1. **"The sitemaps only list 1,000 URLs against 414k eligible models."** True, and irrelevant —
   see [Explicitly not doing](#explicitly-not-doing).
2. **"Impressions are down ~43% since June."** Also true, and also a non-event: over the same
   window **clicks were flat (+1%), CTR rose ~87%, and average position improved.** We shed
   impressions that never converted, which is what AI Overviews does to deep-position listings.
3. **"Google rejects ~3M of our pages, so they must be thin."** They are not. Sampling the
   `Crawled — currently not indexed` drilldown against the database, the rejected model pages are
   **above our own site median** on both downloads and ratings; the rejected user profiles are not
   empty either.

What is actually happening is ordinary for a UGC catalogue of this size: Google indexes a sample
of a large set of structurally interchangeable, template-driven pages and drops the rest. There is
no lever that makes 414,000 model pages individually distinctive, and the indexed set we have is
carrying the traffic.

**So there is no SEO emergency, and the question is where growth comes from rather than what is
broken.** Two answers: fix the one genuinely self-inflicted bucket (tag pages, below), and build
page types that answer questions rather than state records.

---

## 1. Tag pages are generating soft 404s — the one real defect

**Priority. This is the only finding here that is both large and ours.**

The `Soft 404` drilldown is **88% `/tag/*`**. The cause is visible in the database:

| | Tags | Share |
| --- | ---: | ---: |
| Total tags | 578,091 | |
| …with **zero** models | 309,592 | 53.6% |
| …with 1–4 models | 233,055 | 40.3% |
| …with 20+ models | 10,121 | 1.8% |
| …whose name exceeds 40 characters | 14,779 | 2.6% |

Tag volume is skewed hard: 94% have four models or fewer, and every tag is an indexable URL. But
volume turned out **not** to be the cause — see below. `/tag/badik` returns `200` with a meta
description reading *"Browse 4 … models tagged with badik,"* and a grid showing none of them.

Whatever is done here must leave the head alone: `/tag/red`, `/tag/nsfw` and `/tag/lora` are
all top-20 pages by clicks, and `/tag/red` converts at over 11% CTR — better than the site average
and several times the ecosystem hub pages.

### Why the pages are empty

Not because the tags are thin — because of the **default filter**. `modelFilterSchema` defaults to
`period: Month` with `periodMode: 'published'`, so the grid only shows models whose
`lastVersionAt` falls inside a 30-day window. A tag whose models all shipped earlier renders
nothing, while the meta description and `CollectionPage` schema on the same page advertise the
full all-time count. Measured: **224,624 of the 243,469 tags that have published models — 92% —
render an empty grid under the default**, and 22,931 of those have five models or more.

🔴 **Do NOT fix this by deindexing thin tags.** An earlier draft of this doc proposed exactly that,
before the cause was known. It would have deindexed 200,000+ pages that have perfectly good content
sitting just outside a 30-day window.

### Shipped: a stop-gap, and it is only a stop-gap

`periodFallback` (opt-in, `/tag/:name` only) retries the **first page** at `AllTime` when a
period-filtered query returns nothing. Empty pages now show their content.

⚠️ **It fires on exactly zero results, and the bad experience does not start at zero.** A tag with
255 models where 3 shipped last month shows 3 of 255 — the fallback does not fire, and the page is
still wrong in the way that matters. This fixes what Search Console can see, not the whole problem.
Do not read the existence of `periodFallback` as "tag page defaults are solved."

### The real fix, not yet built

**The default period should come from the tag's volume, decided server-side.** A tag page is a
collection lookup — the visitor already said "show me things tagged X" — so a 30-day window is the
wrong default for the surface, not merely an unlucky one. But a blanket `AllTime` is wrong too:
recency genuinely helps the head tags (`/tag/red`, `/tag/nsfw`, `/tag/lora`), which are among
the site's best-performing pages.

`getTagPageSeoData` already returns the count and is already cached for a day, so the decision is
free. Hold the resulting period as page-local state rather than writing it to the shared
`model-filters` localStorage key — that key is global, and flipping it on a tag page would
silently change the visitor's browse default everywhere else.

Getting the threshold slightly wrong here is cheap: it changes a default sort window the user can
see and override, not whether a page is indexed.

When this lands, delete `periodFallback`, `periodFallbackApplied`, and the retry block in
`getModelsInfiniteHandler`.

**Closing condition:** the tag page derives its default period server-side from tag volume, the
`periodFallback` machinery is deleted in the same PR, and a follow-up GSC export shows the
soft-404 count falling without the head tags losing impressions.

### Separately: junk tags exist upstream of any of this

14,779 tags have names over 40 characters, the longest observed being 1,049 — whole prompts rendered
as tag URLs. Whatever creates tags from prompt text is producing vocabulary no human will search
for. Blocking it at the source is cheaper than handling the output forever.

**Closing condition:** the tag-creation path rejects or truncates prompt-shaped input, and the count
of tags over 40 characters stops growing.

### A third source of truth for `period`

Worth knowing before anyone touches this area. `period` is resolved three different ways:
localStorage (`model-filters`, what the query actually uses), the URL (what
`ModelFiltersDropdown` reads in `filterMode="query"`), and the schema default (what SSR renders,
because `getInitialValues` returns `schema.parse({})` when `window` is undefined). Which one
wins depends on a prop default inside the dropdown component.

That split is also a live hydration hazard: a returning visitor whose stored period is not `Month`
gets SSR markup for `Month` and then a client re-render.

---

## 2. Entity and structured-data foundation

**Status: built 2026-09-15 (`4fa44ae5f8`), not yet verified against a deployed page.**

The site had no site-level entity definition at all — no `Organization`, no `sameAs`, no `WebSite`.
A crawl of a detail page returned exactly two JSON-LD blocks (`VideoObject` and `Person`), so
Google had no structured statement of what Civitai is or what it is authoritative about, which is
what AI Overview citation and knowledge-panel treatment lean on.

| Item | State before | Now |
| --- | --- | --- |
| `Organization` + `sameAs` | Absent | Emitted site-wide on green, from `_app` |
| `WebSite` node | Absent | Every domain; `publisher`-linked to the Organization on green |
| `BreadcrumbList` on detail pages | `/ecosystems` only | Model, article and image/video detail pages |
| `SearchAction` | Absent | **Deliberately still absent** — see below |
| `HowTo` on instructional content | Absent | Still absent — needs an editorial call on which articles qualify |

Implementation is `src/components/Meta/site-schema.ts`, emitted from `_app.tsx` for the site-wide
nodes and passed per-page through a `Meta` prop, `breadcrumb`. Breadcrumbs get their own `<script>`
rather than joining the page's entity schema, because `Gated` augments `meta.schema` with paywall
properties when serving a verified bot — merged into a `@graph` root those would land on the
container instead of the entity.

`sameAs` uses the real profile URLs, not the `/discord`-style internal redirects the footer links
through (targets are in `next.config.mjs`) — a redirect on our own host proves nothing about
account ownership.

**The `Organization` node is green-only, on purpose.** `sameAs` is what ties our social accounts
into the entity graph, and pointing those at the mature domain is a brand decision rather than a
technical one. Red still gets its own `WebSite` node so the property is identified; it is simply not
attributed to the Organization.

**No `SearchAction`.** robots.txt deliberately disallows `/search/*` and `*?query=` as thin
duplicate content, so declaring a search target would contradict a rule worth keeping — for a
feature Google has been winding down since 2024.

⚠️ **Do not change the `aggregateRating` on model pages without checking this first.** Review
snippets are by a wide margin the site's largest rich-result surface — more clicks than every other
search-appearance type combined, several times over. That is the model-page `aggregateRating`
earning its keep, and it is the one piece of structured data on the site with proven revenue.

**Closing condition:** Google's Rich Results Test reports a valid `Organization` and
`BreadcrumbList` on a deployed green model page, and a `WebSite` with no Organization on a red one.
Needs a deploy.

---

## 3. Answer pages — the ecosystem hubs work, per page

The ecosystem hub pages are the only part of the site built like modern SEO: structured overview,
comparison, prompt guidance and FAQ sections, backed by `FAQPage` and `BreadcrumbList` schema.
Configs live in `src/shared/constants/ecosystem-seo.constants.ts`; the pattern is tooled via the
`ecosystem-seo-page` skill.

**Measured over three months, they earn about a quarter of a percent of site clicks — from 36
pages, against 414,000 model pages.** Per page that is an enormous multiple: the best ecosystem
page outearns all but a handful of individual models, and three of them rank at average position
6–7. Only 7 of 36 cleared the top-1000-pages export floor, so the tail is marginal.

The weak spot is **click-through, not ranking**: the hub pages convert at 1.5–3.2% while
`/tag/red` converts at over 11%. They are being seen and not clicked.

So the order of work is:

1. **Fix CTR on the pages that already rank** before authoring more. Titles and meta descriptions
   are the cheapest lever, and two pages (`stable-diffusion` at avg position ~22, `sdxl` at ~14)
   are ranking badly enough to be worth a separate look.
2. **Then expand the axis — more question shapes, not more ecosystems.** Comparisons (`X vs Y`),
   "best `<thing>` for `<ecosystem>`", recommended-settings pages.

**The differentiator is that these can be computed from our own corpus.** A hand-written "best
LoRAs" post is stale in six weeks; a page backed by live download and rating data refreshes itself,
and nobody else can write it truthfully. It is also the structural answer to the tail problem: an
aggregation page is unique by construction, not by luck.

**Closing condition:** a second page *shape* (not a 37th ecosystem) ships with its data derived
from a query rather than a hand-maintained config, and Briant confirms the numbers against a
spot-check.

---

## 4. Articles — measure before building

Tens of thousands of published articles: human-written tutorials, workflows and guides. That is the
most citable content already on the site and the closest thing we have to answer pages.

There is already a signal worth chasing — the articles explaining the civitai.red migration are
among the highest-click pages on the whole site, beating every model page except the very top few.
Editorial content plainly works here; nobody has looked at whether that generalises.

**Closing condition:** a GSC Performance export filtered to `/articles/*` is compared against the
site baseline, and the result is written into this doc as a go/no-go.

---

## 5. Video detail pages — deindexed everywhere, on evidence

**Decided 2026-09-16: every `/images/:id` page is `noindex` on every domain, videos included.**
`b7a23ed785` (2026-06-29) had made safe-rated video pages indexable on green; that is reverted.

### What the evidence said

A Search Console Performance export filtered to the **Videos** search appearance (green, last three
months) attributes nearly all video-result clicks to pages that embed a video alongside real
content: model pages carried roughly two-thirds, then posts, articles and collections. The
`/images/:id` video pages — indexable for two and a half months by then — appeared **once** in the
export, with effectively no clicks. The template does not earn search traffic even when indexed.

The pages are thin by our own choice. One generated string ("Video posted by <user>") serves as the
title, the og:title and both `VideoObject` fields, and there is no meta description. The only
per-page text is the prompt, and there is a standing decision to keep unmoderated prompt text out of
titles and search snippets. Indexing them adds near-identical pages to a site where Google already
declines to index a large share of what it crawls.

### Red

Indexing mature video pages on civitai.red was considered and declined for the same reason: it is the
same template, and roughly six in seven videos are mature, so it would multiply the thin pages
rather than add value. A check of red's own Videos appearance cannot settle this, because red's video
pages were deindexed during the window it covers — the impressions it shows come from other pages
that embed videos.

### The "Video isn't on a watch page" warnings

Leave them. Google reports them for model and post pages that embed a video, and those are exactly
the pages earning the video clicks. There are ways to point Google at `/images/:id` as the watch page
(a video sitemap, crawlable gallery links — model pages currently have none), but doing so would
likely move video credit from the model page to the thin page. Not doing it.

**Revisit only if** there is new evidence that a standalone video page can earn traffic — for example
a template with genuine per-page text that is not the prompt.

---

## Explicitly not doing

Recorded so the reasoning is not re-derived from scratch.

### Monthly sitemap partitioning

`docs/seo-sitemap-migration.md` carries a complete design for time-partitioned sitemaps, motivated
by the `LIMIT 1000` cap on the model and article sitemaps. **It should not be built on SEO
grounds.** GSC reports `Discovered — currently not indexed` in the low *tens of pages*: Google has
crawled essentially every URL it knows about, so a larger sitemap hands it nothing it does not
already have. The cap is real and the design is sound; it solves a problem we do not have.

Build it only if a future coverage export shows discovery actually backing up.

### Chasing `Crawled — currently not indexed`

The largest not-indexed bucket, spread roughly evenly across model, user, tag and post pages. The
rejected pages sample **above** our site median on downloads and ratings, so this is not a quality
filter that better pages would pass — it is Google sampling a large template-driven catalogue.
Every UGC site at this scale has it.

Revisit only if the *indexed* count starts falling, which it is not; it has been rising steadily.

### More detail pages of any kind

Any project whose output is more model, image or post pages for indexing is adding to the pile
Google is already declining. The bottleneck is what a page *says*, not how many exist.
