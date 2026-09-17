# SEO Improvements — What To Build

A ranked list of work that would improve how civitai.com and civitai.red rank, what has shipped, and
what should deliberately *not* be built. Companion to [seo-audit.md](seo-audit.md), which is the
per-page posture reference; this doc is the backlog and the decision record.

Started 2026-09-15, from a Search Console video-indexing error that turned into a coverage review.
Last updated 2026-09-17.

> **This repo is public.** Absolute Search Console figures — click and impression totals, indexed
> page counts — are deliberately not reproduced here; they are business metrics a competitor cannot
> otherwise observe. Ratios and structural findings are kept, because they are what the decisions
> below rest on and they leak nothing useful. Pull a current export rather than trusting a figure
> written down months ago.

## Shipped so far

| Commit | What |
| --- | --- |
| `4fa44ae5f8` | Site-wide `Organization` / `WebSite` schema, breadcrumbs on detail pages ([§2](#2-entity-and-structured-data-foundation)) |
| `9b7b5dcc6c` | Fix: site schema crashed client-side navigation when `_app` props were absent |
| `e60d745f97` | Tag pages retry at AllTime when the default period filter finds nothing ([§1](#1-tag-pages-generating-soft-404s)) |
| `5549de7353` | Green tag pages count and list safe models only; mature-only tags noindexed on green ([§1](#1-tag-pages-generating-soft-404s)) |
| `9b9daf8876` | Search-shaped titles and descriptions for seven ecosystem pages; Krea 2 and SD 1.5 copy corrected ([§3](#3-answer-pages--the-ecosystem-hubs)) |
| `cbc3124738` | Video detail pages deindexed on every domain ([§5](#5-video-detail-pages--deindexed-everywhere)) |
| `dda7ee687a`, `705ff26e0c` | Articles sitemap widened to official, moderator and engaged articles ([§4](#4-articles)) |

---

## The premise, corrected

The review opened by assuming three things were wrong. Measurement killed all three, and the
record is kept here so they are not re-opened:

1. **"The sitemaps only list 1,000 URLs against 414k eligible models."** True, and irrelevant for
   discovery — see [Explicitly not doing](#explicitly-not-doing).
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
broken.**

---

## 1. Tag pages generating soft 404s

**Status: causes fixed (`e60d745f97`, `5549de7353`); confirm with a re-export.**

The `Soft 404` drilldown was **88% `/tag/*`**. Two causes, both now addressed:

**The default period filter hid content.** `modelFilterSchema` defaults to `period: Month` with
`periodMode: 'published'`, so a tag's grid only showed models whose `lastVersionAt` fell inside a
30-day window — while the meta description and `CollectionPage` schema advertised the full count.
**224,624 of the 243,469 tags with published models (92%) rendered an empty grid.** In the soft-404
sample, about 87% of tag URLs had models green can show, so this was their cause.

**Mature-only tags are empty on green.** Green filters out mature models, so a tag whose models are
all mature shows nothing there regardless of period. About 12% of the sample.

What shipped:

- **`periodFallback`** (opt-in, `/tag/:name` only) retries the first page at `AllTime` when a
  period-filtered query returns nothing.
- **`getTagPageSeoData({ safeOnly })`** — on green the count and the listed models are filtered to
  green-visible models, so the description and schema stop advertising mature models. A green-only
  `EXISTS` separates "no models at all" from "mature models only", and the second case is
  `noindex` on green. Red keeps the unfiltered data and stays indexed. The two variants are cached
  separately.

🔴 **Do not "fix" soft 404s by deindexing tags with few models.** Google ranks tag pages by what
people search for, not by how much they list: one of the top tag pages by clicks has four models,
and a minimum-model rule would have deindexed 200,000+ pages that had content hidden only by the
period filter.

### `periodFallback` is a stop-gap

It fires on **exactly zero** results. A tag with 255 models where 3 shipped last month shows 3 of
255; the fallback does not fire. The real fix is for the tag page to derive its default period from
tag volume server-side (`getTagPageSeoData` already has the count), held as page-local state rather
than written to the shared `model-filters` localStorage key. Filters were set aside on 2026-09-16,
so this is parked.

**Closing condition:** the tag page derives its default period server-side, the `periodFallback`
machinery is deleted in the same PR, and a soft-404 re-export shows the count falling without the
head tags losing impressions.

### Considered and deferred: a minimum-model threshold for indexing

After the fixes above, the remaining soft-404 tags are mostly thin (one or two models). A `noindex`
threshold was evaluated against the sample: a minimum of **2 safe models** would cover about 60% of
it and drop two tags that earn clicks — one of them a brand/navigation search (`civitai red`) that
would need an exemption. A minimum of 3 or more starts dropping tags that earn a few hundred clicks.

Deferred, because it would mostly move pages between two "not indexed" buckets: a soft 404 is
already Google declining the page, and crawl budget is not constrained (see
[Explicitly not doing](#explicitly-not-doing)). **Revisit only if** a soft-404 re-export after the
fixes still shows `/tag/*` dominating; if so, start at 2 with the exemption.

### Considered and dropped: rules on new tag names

A write-path rule (no commas, a word limit, applied only when creating a new tag) was built and then
dropped on 2026-09-16. Commas are not reliably junk:

- `warhammer 40,000` is among the most-used tags with a comma, and 40 tags carry a comma between
  digits.
- About a third of the links on comma tags belong to trailing-comma duplicates (`pokemon,`,
  `celebrity,`), most of which have a clean twin — merging them would keep real tagging.
- Legitimate light-novel titles contain commas and run to 17 words.

Of 17,281 user tags that contain a comma or exceed 20 words, 93% are used once or not at all; they
are an SEO non-issue once their pages are empty-or-noindexed. If a cleanup is ever wanted, merge the
trailing-comma duplicates into their clean tags, keep or normalize the numeric ones, and only then
delete the rest. Note that `TagsOnImageNew` has **no foreign key** to `Tag`, so a tag delete must
remove its image-tag rows explicitly.

### A third source of truth for `period`

Worth knowing before anyone touches this area. `period` is resolved three different ways:
localStorage (`model-filters`, what the query actually uses), the URL (what
`ModelFiltersDropdown` reads in `filterMode="query"`), and the schema default (what SSR renders,
because `getInitialValues` returns `schema.parse({})` when `window` is undefined). Which one
wins depends on a prop default inside the dropdown component. It is also a live hydration hazard: a
returning visitor whose stored period is not `Month` gets SSR markup for `Month`, then a client
re-render.

---

## 2. Entity and structured-data foundation

**Status: shipped (`4fa44ae5f8`, fixed in `9b7b5dcc6c`) and live** — a deployed green model page
serves `Organization` and `WebSite`. Rich Results confirmation is still outstanding.

The site had no site-level entity definition at all — no `Organization`, no `sameAs`, no `WebSite`.
Google had no structured statement of what Civitai is or what it is authoritative about, which is
what AI Overview citation and knowledge-panel treatment lean on.

| Item | Before | Now |
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

`_app` props can be absent on client-side navigation, so `getSiteSchema` treats both of its inputs
as optional (`9b7b5dcc6c`).

`sameAs` uses the real profile URLs, not the `/discord`-style internal redirects the footer links
through (targets are in `next.config.mjs`) — a redirect on our own host proves nothing about
account ownership.

**The `Organization` node is green-only, on purpose.** `sameAs` is what ties our social accounts
into the entity graph, and pointing those at the mature domain is a brand decision rather than a
technical one. Red still gets its own `WebSite` node so the property is identified.

**No `SearchAction`.** robots.txt deliberately disallows `/search/*` and `*?query=` as thin
duplicate content, so declaring a search target would contradict a rule worth keeping — for a
feature Google has been winding down since 2024.

⚠️ **Do not change the `aggregateRating` on model pages without checking this first.** Review
snippets are by a wide margin the site's largest rich-result surface — more clicks than every other
search-appearance type combined, several times over.

**Closing condition:** Google's Rich Results Test (or validator.schema.org) reports a valid
`Organization` and `BreadcrumbList` on a deployed green model page, and a `WebSite` with no
Organization on a red one.

---

## 3. Answer pages — the ecosystem hubs

The ecosystem hub pages are the only part of the site built like modern SEO: structured overview,
comparison, prompt guidance and FAQ sections, backed by `FAQPage` and `BreadcrumbList` schema.
Configs live in `src/shared/constants/ecosystem-seo.constants.ts`; the pattern is tooled via the
`ecosystem-seo-page` skill.

Per page they hugely outperform model pages: the best hub outearns all but a handful of individual
models, and several rank at average position 6–7. The weak spot was **click-through, not ranking** —
hub pages converted several times worse than the best tag pages. Bare-name queries ("krea2",
"sdxl") click through worst; version-specific ones ("illustrious xl", "pony diffusion v6 xl",
"noobai xl") click through far better.

### Shipped: search-shaped titles and descriptions (`9b9daf8876`)

- Configs can set `seoTitle`; pages without it keep "{name} AI Models & Generator | Civitai".
- Title and description accept the `{loras:Key}` token (resolved from live data; a missing count
  drops the number instead of printing a dash). `getLoraCountKeys` collects tokens from the title
  and description as well as the comparison table.
- Seven pages rewritten — krea2, illustrious, anima, sdxl, pony, noobai, stable-diffusion — to name
  the searched version and lead with downloads, LoRAs and generating online, e.g.
  "Illustrious XL Models & 197K+ LoRAs | Civitai".
- **Krea 2's page contradicted the generator** and was corrected: it described moodboards (the
  generator has style references only), presented style references and the creativity dial as
  general controls (Large/Medium only), said negative prompts aren't a channel (Raw and Turbo have
  one), called Large/Medium "the default" (the generator defaults to Raw), and omitted image
  editing, which the generator offers and people search for.
- **SD 1.5's page claimed the largest LoRA library** in four places; Illustrious now has more.
- `ecosystem-seo-meta.test.ts` holds every custom title to 60 characters and description to 160 with
  the widest count substituted.

### Next

1. **Extend the length check to every page.** It only covers pages with a custom title; FLUX.1's
   existing description is already over the limit, and others likely are.
2. **Measure.** A Performance export filtered to `/ecosystems/`, before and ~4 weeks after the
   deploy, is the only way to know whether CTR moved.
3. **`stable-diffusion` and `sdxl`** rank far lower than the other hubs; look at what outranks them
   once the new titles have settled.
4. **A fuller Krea 2 editing section** — the "krea 2 identity edit" searches have real volume.
5. **Then expand the axis — more question shapes, not more ecosystems.** Comparisons (`X vs Y`),
   "best `<thing>` for `<ecosystem>`", recommended-settings pages, computed from our own corpus so
   they stay current and are unique by construction.

**Closing condition (5):** a second page *shape* (not a 37th ecosystem) ships with its data derived
from a query rather than a hand-maintained config, and Briant confirms the numbers against a
spot-check.

---

## 4. Articles

Tens of thousands of published articles: human-written tutorials, workflows and guides — the most
citable content already on the site. Articles that earn search clicks have a median engagement
roughly four times the site's.

### Shipped: the articles sitemap lists the articles worth advertising (`dda7ee687a`, `705ff26e0c`)

It used to list the newest 1,000 articles per domain. An article is now listed when it is
published, searchable (`availability != 'Unsearchable'`), not blocked by the scanner (the page 404s
those), canonical on the requesting domain, and at least one of:

- **official** — `Article.isOfficial`, set only by moderators
- **written by a moderator**
- **engagement ≥ 5** — reactions + comments + collects, all-time from `ArticleMetric`

Views are excluded because search traffic inflates them. Order is official, then moderator, then
engagement; Google ignores sitemap order, so it only decides what survives the 50,000 per-file
cap. That comes to roughly 5,200 articles on green and 7,200 on red, from a query that runs in
~100 ms.

Leaving an article out does **not** deindex it — Google still reaches it through links. The bar is
low on purpose: engagement is a weak signal at the bottom (some articles with single-digit
engagement earn real traffic). A 30-day recency rule was tried and dropped: it advertised
zero-engagement posts, and discovery isn't a constraint.

Domain membership matches the article page's `Gated` rules exactly: green lists PG only (PG-13 is
login-gated for anonymous visitors, crawlers included; unrated and mature content is not indexable
there), red lists articles with no safe bits. The rating used is the effective `nsfwLevel`, which
takes a moderator's rating over the author's.

`getArticleUrl` builds the canonical URL for the sitemap, the page's `canonical`, and the share
button; a title with no slug-able characters gets the bare `/articles/{id}` rather than a
trailing-slash URL that gets redirected.

### Next

- **Measure before building more.** A Performance export filtered to `/articles/` shows which
  articles earn search traffic and for which queries — that decides whether to invest in official
  guides, promote articles, or leave it.
- `lastmod` still uses `publishedAt`, so edits don't signal change. Optional.

**Closing condition:** the `/articles/` export is compared against the site baseline, and the
result is written here as a go/no-go on further article work.

---

## 5. Video detail pages — deindexed everywhere

**Decided 2026-09-16, shipped in `cbc3124738`: every `/images/:id` page is `noindex` on every
domain, videos included.** `b7a23ed785` (2026-06-29) had made safe-rated video pages indexable on
green; that is reverted.

### What the evidence said

A Search Console Performance export filtered to the **Videos** search appearance (green, last three
months) attributes nearly all video-result clicks to pages that embed a video alongside real
content: model pages carried roughly two-thirds, then posts, articles and collections. The
`/images/:id` video pages — indexable for two and a half months by then — appeared **once** in the
export, with effectively no clicks.

The pages are thin by our own choice. One generated string ("Video posted by <user>") serves as the
title, the og:title and both `VideoObject` fields, and there is no meta description. The only
per-page text is the prompt, and there is a standing decision to keep unmoderated prompt text out of
titles and search snippets.

### Red

Indexing mature video pages on civitai.red was declined for the same reason: same template, and
roughly six in seven videos are mature, so it would multiply the thin pages. Red's own Videos
appearance cannot settle this, because red's video pages were deindexed during the window it covers.

### The "Video isn't on a watch page" warnings

Leave them. Google reports them for model and post pages that embed a video, and those are exactly
the pages earning the video clicks. Pointing Google at `/images/:id` as the watch page (a video
sitemap, crawlable gallery links — model pages currently have none) would likely move video credit
from the model page to the thin page.

**Revisit only if** there is new evidence that a standalone video page can earn traffic — for example
a template with genuine per-page text that is not the prompt.

---

## Open questions

- **Can Googlebot crawl civitai.red?** From outside, every civitai.red URL — including `robots.txt`
  and the sitemaps — returns a Cloudflare challenge to anything that isn't a real browser. Verified
  crawlers are normally exempt; confirm in the red Search Console property (Sitemaps status,
  robots.txt report). If they are not exempt, that outranks everything else here for red.

---

## Explicitly not doing

Recorded so the reasoning is not re-derived from scratch.

### Widening the model sitemap / monthly sitemap partitioning

`docs/seo-sitemap-migration.md` carries a complete design for time-partitioned sitemaps, motivated
by the `LIMIT 1000` cap on the model sitemap. **It should not be built on discovery grounds.** GSC
reports `Discovered — currently not indexed` in the low *tens of pages*: Google has crawled
essentially every URL it knows about, so a larger sitemap hands it nothing it does not already have.

The articles sitemap was widened anyway, for a different reason: it is a curated list of articles
we want to advertise, not a discovery fix, and it fits in one file. The same argument doesn't carry
to models, where the eligible set is hundreds of thousands of pages Google already samples.

Build partitioning only if a future coverage export shows discovery actually backing up.

### Chasing `Crawled — currently not indexed`

The largest not-indexed bucket, spread roughly evenly across model, user, tag and post pages. The
rejected pages sample **above** our site median on downloads and ratings, so this is not a quality
filter that better pages would pass — it is Google sampling a large template-driven catalogue.

Revisit only if the *indexed* count starts falling, which it is not; it has been rising steadily.

### More detail pages of any kind

Any project whose output is more model, image or post pages for indexing is adding to the pile
Google is already declining. The bottleneck is what a page *says*, not how many exist.

### Filter redesign as an SEO fix

A time-decayed "hot" sort and a sparse filter store were explored and set aside on 2026-09-16. The
tag-page symptom is handled by §1; the filter system's own problems are product work, not SEO work.
