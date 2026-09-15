# SEO Improvements — What To Build

A ranked list of work that would improve how civitai.com and civitai.red rank, and what
should deliberately *not* be built. Companion to [seo-audit.md](seo-audit.md), which is the
per-page posture reference; this doc is the backlog.

Started 2026-09-15, from a Search Console video-indexing error that turned into a coverage review.

> **This repo is public.** Search Console impression counts, indexed-page totals and traffic
> trends are deliberately not reproduced here — they are business metrics a competitor cannot
> otherwise observe. The findings below are all verifiable by fetching the live site. When an
> item needs a number to justify it, pull the current GSC export rather than trusting a figure
> written down months ago.

---

## The premise

**Google ranks answers. We are a database.**

The largest category of not-indexed pages is "Crawled — currently not indexed": Google fetched
the page, evaluated it, and declined to keep it. At that volume it is a verdict on a page
*class*, not on individual pages — and the classes in question are model, post and image detail
pages, each of which states a *record* rather than answering a question.

"Discovered — currently not indexed" is, by contrast, negligible. There is no discovery
backlog, which means **nothing in the sitemap or crawl-plumbing layer is worth building.** See
[Explicitly not doing](#explicitly-not-doing).

So the work that pays is the work that turns records into answers, plus the structured-data
floor that lets Google understand what it is looking at.

---

## 1. Entity and structured-data foundation

**Status: built 2026-09-15, not yet verified against a deployed page.**

The site had no site-level entity definition at all — no `Organization`, no `sameAs`, no
`WebSite`/`SearchAction`. A crawl of a detail page returned exactly two JSON-LD blocks
(`VideoObject` and `Person`) for a property of well over a million indexed pages. Google had no
structured statement of what Civitai is, who publishes it, or what it is authoritative about.

That matters more than it used to: AI Overview citation and knowledge-panel treatment both lean
on entity confidence, and entity confidence is built from exactly these signals.

| Item | State before | Now |
| --- | --- | --- |
| `Organization` + `sameAs` | Absent | Emitted site-wide on green, from `_app` |
| `WebSite` node | Absent | Emitted on every domain, `publisher`-linked to the Organization on green |
| `BreadcrumbList` on detail pages | `/ecosystems` only | Model, article and image/video detail pages |
| `SearchAction` | Absent | **Deliberately still absent** — see below |
| `HowTo` on instructional content | Absent | Still absent — needs an editorial call on which articles qualify |

Implementation is `src/components/Meta/site-schema.ts`, emitted from `_app.tsx` for the
site-wide nodes and passed per-page through a new `Meta` prop, `breadcrumb`. Breadcrumbs get
their own `<script>` rather than joining the page's entity schema, because `Gated` augments
`meta.schema` with paywall properties when serving a verified bot — merged into a `@graph` root
those properties would land on the container instead of the entity.

`sameAs` uses the real profile URLs, not the `/discord`-style internal redirects the footer
links through (targets are in `next.config.mjs`) — a redirect on our own host proves nothing
about account ownership.

**The `Organization` node is green-only, on purpose.** `sameAs` is what ties our social accounts
into the entity graph, and pointing those accounts at the mature domain is a brand decision
rather than a technical one. Red still gets its own `WebSite` node so the property is
identified; it is simply not attributed to the Organization. Widening it is one line if that
decision is ever made deliberately.

**No `SearchAction`.** robots.txt deliberately disallows `/search/*` and `*?query=` as thin
duplicate content, so declaring a search target would contradict a rule worth keeping — for a
feature Google has been winding down since 2024.

**Closing condition:** Google's Rich Results Test reports a valid `Organization` and
`BreadcrumbList` on a deployed green model page, and a `WebSite` with no Organization on a red
one. Not yet done — this needs a deploy.

---

## 2. Answer pages — scale the ecosystem pattern

**The ecosystem hub pages are the only part of the site built like modern SEO** — structured
overview, comparison, prompt guidance and FAQ sections, backed by `FAQPage` and
`BreadcrumbList` schema. The pattern is already tooled via the `ecosystem-seo-page` skill, and
the configs live in `src/shared/constants/ecosystem-seo.constants.ts`.

The expansion axis is **not more ecosystems** — it is more *question shapes*:

- Comparison pages (`X vs Y`) — real query volume, and we hold the data to answer honestly
- "Best `<thing>` for `<ecosystem>`" — a query people actually type
- Recommended-settings pages — derived from generations that actually succeeded

**The differentiator is that these can be computed from our own corpus.** A hand-written "best
LoRAs" post is stale in six weeks; a page backed by live download and rating data refreshes
itself, and nobody else can write it truthfully. That is also the structural answer to the
thin-content verdict: an aggregation page is unique by construction, not by luck.

**Closing condition:** a second page *shape* (not just a 37th ecosystem) ships with its data
derived from a query rather than a hand-maintained config, and Briant confirms it renders
correct numbers against a spot-check.

---

## 3. Articles — measure before building

There are tens of thousands of published articles: human-written tutorials, workflows and
guides. That is the most citable content already on the site and the closest thing we have to
answer pages, and nobody has looked at how it performs.

Do the measurement before authoring or restructuring anything:

- Are articles indexed at a better rate than model pages?
- Do they earn impressions disproportionate to their share of indexed pages?

If yes, the cheapest available growth is markup and internal linking on a corpus that already
exists — not new content.

**Closing condition:** a GSC Performance export filtered to `/articles/*` is compared against
the site baseline, and the result is written into this doc as a go/no-go.

---

## 4. Diagnosed problems worth chasing

Both are larger than the video issue that started this review, and both concern pages we
actively want indexed.

### Soft 404s

Google receives `200 OK` and judges the body to be an error or empty page. The profile fits the
mature-content interstitial on green: real meta tags, but a body that says the content has
moved to civitai.red. To a crawler that is a 200 with no content — the textbook soft 404, and
exactly the content/meta mismatch predicted in
[seo-audit.md § Crawler behavior at the domain boundary](seo-audit.md).

If confirmed, the fix is the existing house pattern — `Gated` should be deindexing those URLs
on green rather than serving a 200 shell.

**Closing condition:** the GSC soft-404 drilldown is exported and the URL patterns are either
confirmed as the interstitial (→ fix in `Gated`) or identified as something else (→ new entry
here). This is a hypothesis, not a diagnosis, until that export exists.

### Google overriding our canonical

"Duplicate, Google chose different canonical than user" means we declared a canonical and
Google picked a different URL anyway — it judged two of our pages to be the same page. Plausible
at scale given slug / slug-less pairs, per-version URLs and tag permutations.

It costs more than the count suggests: when Google picks, our chosen URL loses its ranking
signals to whichever one Google preferred, and the page we want to rank may not be the one it
kept. This is [seo-audit.md](seo-audit.md) open question #2 — canonical format consistency
across entity types — still unanswered since April 2026.

**Closing condition:** the drilldown is exported, the entity types involved are named, and a
canonical convention is written down in `seo-audit.md` and applied.

---

## 5. Video detail pages — decided, not scheduled

The watch pages work. A Googlebot fetch of a safe-rated video page returns 200 with a
server-rendered `<video>`, a self-canonical, no `noindex`, and a `VideoObject` whose
`contentUrl` matches the file Search Console flagged. The CDN serves no `robots.txt`, so nothing
blocks the media. The backlog of "Video isn't on a watch page" errors are stale verdicts
recorded while every image page was still deindexed, before
`b7a23ed785 feat(seo): index safe-rated video detail pages with VideoObject schema` (2026-06-29).

Two real defects remain, both in `src/components/Image/DetailV2/ImageDetail2.tsx`:

- One generated `title` string serves as the `<title>`, the `og:title`, **and** both
  `VideoObject.name` and `.description`. Every video by a given user therefore carries an
  identical title, and no meta `description` is emitted at all.
- `duration` is absent, and is a recommended `VideoObject` property.

**These are not scheduled, deliberately.** The only genuinely per-page-unique field these pages
hold is the prompt, and there is a standing decision not to surface prompt text in titles or
SERP snippets — it is unmoderated user text on a Google-owned surface with no review step. That
decision and "these pages will not be distinctive" are the same decision. A non-prompt
alternative exists (titles built from the resources used, which are moderated text and better
aligned with query intent than prompts), but resources are not currently in the SSR payload, so
it is only worth doing if something else wants them there.

Safe-rated video pages stay indexed for now — reverting `b7a23ed785` was considered and declined
on 2026-09-15.

**Closing condition:** none — this is a recorded decision, not a work item. Revisit only if the
metadata policy changes or resources land in SSR for another reason.

---

## Explicitly not doing

Recorded so the reasoning is not re-derived from scratch.

### Monthly sitemap partitioning

`docs/seo-sitemap-migration.md` carries a complete design for time-partitioned sitemaps,
motivated by the `LIMIT 1000` cap on the model and article sitemaps. **It should not be built on
SEO grounds.** The GSC coverage export shows "Discovered — currently not indexed" in the low
tens of pages: Google has crawled essentially every URL it knows about, so a larger sitemap
hands it nothing it does not already have.

The cap is real and the design is sound. It is simply solving a problem we do not have. Build it
only if a future coverage export shows discovery actually backing up.

### More detail pages of any kind

Any project whose output is more model, image or post pages for indexing is adding to the pile
Google is already declining. The bottleneck is what a page *says*, not how many exist.
