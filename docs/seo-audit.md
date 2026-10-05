# SEO Audit — Base Document

A running reference for auditing Civitai's SEO posture. This is the "what
we know and where the gaps are" doc — findings and fixes should be appended
as sections below.

Started: 2026-04-24 (Briant).

---

## Context: .com vs .red

Civitai runs under two canonical hosts driven by the same codebase:

| Domain | Role | Content |
| --- | --- | --- |
| `civitai.com` (green) | SFW site | Content whose `nsfwLevel` passes `hasSafeBrowsingLevel` |
| `civitai.red` (red / blue) | NSFW site | Everything, including mature content |

The domain is resolved server-side in [_app.tsx:419](../src/pages/_app.tsx#L419)
(`canIndex = serverDomainMap values includes host`) and surfaced to React via
`useDomainColor()` in [src/hooks/useDomainColor.tsx](../src/hooks/useDomainColor.tsx).
Feature-flag style: `isGreen` = .com, `isBlue` / `isRed` = .red variants.

### Crawler behavior at the domain boundary

When a user requests an NSFW resource on `.com`:

1. SSR renders the page.
2. [`<Meta>`](../src/components/Meta/Meta.tsx) is rendered *outside*
   [`<SensitiveShield>`](../src/components/SensitiveShield/SensitiveShield.tsx) so
   meta tags are always present.
3. Inside the shield, a replacement card ("Mature content has a new home →
   civitai.red") is rendered instead of the real body.
4. Googlebot (logged-out, safe-level only) receives: canonical title + description
   for the article, but a body that redirects off-site.

This creates a **content/meta mismatch** if the URL remains indexable on `.com`.
The fix pattern is to toggle `deIndex` based on both `nsfwLevel` and the domain:
when we're on green and content is NSFW, emit `noindex,nofollow` so the `.red`
URL wins the canonical fight.

### Meta component safeguards

[`Meta`](../src/components/Meta/Meta.tsx) already does the right thing for
images: [line 75](../src/components/Meta/Meta.tsx#L75) only selects
`getIsSafeBrowsingLevel` images for `og:image`. The primary source is the
`/api/og` endpoint, which is expected to render a SFW preview card regardless of
content rating. **If we ever allow raw-image fallbacks for NSFW content, this
guard is the last line of defense.**

`deIndex`, `canonical`, and `alternate` are page-level controls. Each page is
responsible for passing the right values.

### Global indexing gate

`canIndex` is true whenever the host matches a canonical server domain. It is
NOT sensitive to content rating. `.red` is currently in `canIndex: true`
territory; whether we want `.red` content indexed at all is a product question —
see **Open Questions** below.

---

## Checklist: what a detail-page audit should cover

For every detail page (models, images, posts, articles, collections, user
profiles, bounty, club, etc.):

- [ ] `<Meta>` is outside any visibility gate (`SensitiveShield`, login gate,
      mature-content blur).
- [ ] `description` is derived from content that is safe to show in a SERP
      snippet, or the page is de-indexed when the content is NSFW.
- [ ] `og:image` uses either `/api/og` or a SFW-filtered selector (never an
      unfiltered `image.url`).
- [ ] `deIndex` is set when any of:
      - content is unpublished / draft,
      - `availability === Unsearchable`,
      - we're on `.com` and the content is NSFW.
- [ ] `canonical` points at the production URL with slug (or the slug-less URL
      if that's the canonical choice — be consistent).
- [ ] `alternate` is set if slug-less and slug'd URLs both resolve.
- [ ] JSON-LD schema is present where it adds value (Article, Product,
      Person, ImageObject, etc.) — optional, but worth noting.

---

## Audit checklist

Tick a box once the page has been audited against the checklist above and an
entry has been added to **Findings** below (even if no fix was needed — a "no
issues" note counts).

### P0 — Detail pages with NSFW content

Top priority: these are the pages most likely to produce the content/meta
mismatch described above. All have user-rated content; all need the NSFW-aware
`deIndex` guard.

Most of these now render through [`Gated`](../src/components/Gated/Gated.tsx), which
applies the guard centrally: it deindexes the redirect, login and unrated states, and on a
mature host it deindexes safe content so green stays canonical. Pages ticked "via `Gated`"
get the guard from there; they have not each been audited against the rest of the checklist.

- [x] `/articles/:id/:slug?` — [articles/[id]/[[...slug]].tsx](../src/pages/articles/[id]/[[...slug]].tsx) *(fixed 2026-04-24)*
- [x] `/models/:id/:slug?` — [models/[id]/[[...slug]].tsx](../src/pages/models/[id]/[[...slug]].tsx) *(via `Gated`)*
- [ ] `/model-versions/:id` — [model-versions/[id].tsx](../src/pages/model-versions/[id].tsx)
- [x] `/images/:imageId` — [images/[imageId].tsx](../src/pages/images/[imageId].tsx) *(via `Gated`, in `ImageDetail2`; all image and video pages are `noindex` since 2026-09-16)*
- [x] `/posts/:postId/:postSlug?` — [posts/[postId]/[[...postSlug]].tsx](../src/pages/posts/[postId]/[[...postSlug]].tsx) *(via `Gated`, in `PostDetail`)*
- [x] `/bounties/:id/:slug?` — [bounties/[id]/[[...slug]].tsx](../src/pages/bounties/[id]/[[...slug]].tsx) *(via `Gated`)*
- [ ] `/bounties/:id/entries/:entryId` — [bounties/[id]/entries/[entryId]/index.tsx](../src/pages/bounties/[id]/entries/[entryId]/index.tsx)
- [x] `/collections/:collectionId` — [collections/[collectionId]/index.tsx](../src/pages/collections/[collectionId]/index.tsx) *(via `Gated`, in `Collection`)*
- [ ] `/comics/:id/:slug?` — [comics/[id]/[[...slug]].tsx](../src/pages/comics/[id]/[[...slug]].tsx) *(renders a plain `Meta` with a canonical and no NSFW-aware `deIndex`; not on `Gated`)*

### P1 — User-facing pages with mixed or derived content ratings

These aggregate user content (so they can surface NSFW previews in meta) and
are SEO-visible.

- [ ] `/user/:username` — [user/[username]/index.tsx](../src/pages/user/[username]/index.tsx)
- [ ] `/user/:username/models` — [user/[username]/models.tsx](../src/pages/user/[username]/models.tsx)
- [ ] `/user/:username/images` — [user/[username]/images.tsx](../src/pages/user/[username]/images.tsx)
- [ ] `/user/:username/posts` — [user/[username]/posts.tsx](../src/pages/user/[username]/posts.tsx)
- [ ] `/user/:username/videos` — [user/[username]/videos.tsx](../src/pages/user/[username]/videos.tsx)
- [ ] `/user/:username/articles` — [user/[username]/articles.tsx](../src/pages/user/[username]/articles.tsx)
- [ ] `/user/:username/collections` — [user/[username]/collections.tsx](../src/pages/user/[username]/collections.tsx)
- [ ] `/user/:username/comics` — [user/[username]/comics.tsx](../src/pages/user/[username]/comics.tsx)
- [ ] `/user/:username/:list` — [user/[username]/[list].tsx](../src/pages/user/[username]/[list].tsx) (catch-all list route)
- [ ] `/user-id/:userId` — [user-id/[userId].tsx](../src/pages/user-id/[userId].tsx) (confirm canonical points at username URL)
- [x] `/tag/:tagname` — [tag/[tagname].tsx](../src/pages/tag/[tagname].tsx) (tag aggregation, can include NSFW) *(2026-09-16: green counts and lists safe models only and noindexes mature-only tags; see [seo-improvements.md](seo-improvements.md) §1)*
- [ ] `/reviews/:reviewId` — [reviews/[reviewId].tsx](../src/pages/reviews/[reviewId].tsx)
- [ ] `/comments/v2/:id` — [comments/v2/[id].tsx](../src/pages/comments/v2/[id].tsx) (likely should de-index)
- [ ] `/challenges/:id/:slug?` — [challenges/[id]/[[...slug]].tsx](../src/pages/challenges/[id]/[[...slug]].tsx)
- [ ] `/events/:slug` — [events/[slug].tsx](../src/pages/events/[slug].tsx)
- [ ] `/leaderboard/:id` — [leaderboard/[id].tsx](../src/pages/leaderboard/[id].tsx)
- [ ] `/auctions/:slug?` — [auctions/[[...slug]].tsx](../src/pages/auctions/[[...slug]].tsx)
- [ ] `/tools/:slug` — [tools/[slug].tsx](../src/pages/tools/[slug].tsx)

### P2 — Index / feed pages

High traffic, but meta is mostly static per route. Confirm titles,
descriptions, and canonicals are set (not inherited from defaults).

- [ ] `/` — [index.tsx](../src/pages/index.tsx)
- [ ] `/home` — [home/index.tsx](../src/pages/home/index.tsx)
- [ ] `/models` — [models/index.tsx](../src/pages/models/index.tsx)
- [ ] `/images` — [images/index.tsx](../src/pages/images/index.tsx)
- [ ] `/videos` — [videos/index.tsx](../src/pages/videos/index.tsx)
- [ ] `/posts` — [posts/index.tsx](../src/pages/posts/index.tsx)
- [ ] `/articles` — [articles/index.tsx](../src/pages/articles/index.tsx)
- [ ] `/bounties` — [bounties/index.tsx](../src/pages/bounties/index.tsx)
- [ ] `/collections` — [collections/index.tsx](../src/pages/collections/index.tsx)
- [ ] `/comics` — [comics/index.tsx](../src/pages/comics/index.tsx)
- [ ] `/comics/browse` — [comics/browse.tsx](../src/pages/comics/browse.tsx)
- [ ] `/challenges` — [challenges/index.tsx](../src/pages/challenges/index.tsx)
- [ ] `/challenges/winners` — [challenges/winners.tsx](../src/pages/challenges/winners.tsx)
- [ ] `/events` — [events/index.tsx](../src/pages/events/index.tsx)
- [ ] `/tools` — [tools/index.tsx](../src/pages/tools/index.tsx)
- [ ] `/builds` — [builds/index.tsx](../src/pages/builds/index.tsx)
- [ ] `/search/models` — [search/models.tsx](../src/pages/search/models.tsx)
- [ ] `/search/images` — [search/images.tsx](../src/pages/search/images.tsx)
- [ ] `/search/articles` — [search/articles.tsx](../src/pages/search/articles.tsx)
- [ ] `/search/bounties` — [search/bounties.tsx](../src/pages/search/bounties.tsx)
- [ ] `/search/collections` — [search/collections.tsx](../src/pages/search/collections.tsx)
- [ ] `/search/comics` — [search/comics.tsx](../src/pages/search/comics.tsx)
- [ ] `/search/tools` — [search/tools.tsx](../src/pages/search/tools.tsx)
- [ ] `/search/users` — [search/users.tsx](../src/pages/search/users.tsx)

### P3 — Marketing / evergreen / legal

Static (or near-static) pages that should be fully indexed on `.com` and may
benefit from richer meta/schema.

- [ ] `/content/:slug*` — [content/[[...slug]].tsx](../src/pages/content/[[...slug]].tsx) (TOS/Privacy/etc. catch-all)
- [ ] `/pricing` — [pricing/index.tsx](../src/pages/pricing/index.tsx)
- [ ] `/safety` — [safety/index.tsx](../src/pages/safety/index.tsx)
- [ ] `/newsroom` — [newsroom/index.tsx](../src/pages/newsroom/index.tsx)
- [ ] `/support` — [support/index.tsx](../src/pages/support/index.tsx)
- [ ] `/creator-program` — [creator-program/index.tsx](../src/pages/creator-program/index.tsx)
- [ ] `/changelog` — [changelog/index.tsx](../src/pages/changelog/index.tsx)
- [ ] `/product/vault` — [product/vault.tsx](../src/pages/product/vault.tsx)
- [ ] `/product/link` — [product/link.tsx](../src/pages/product/link.tsx)
- [ ] `/product/odor` — [product/odor.tsx](../src/pages/product/odor.tsx)
- [ ] `/shop` — [shop/index.tsx](../src/pages/shop/index.tsx)
- [ ] `/gift-cards` — [gift-cards/index.tsx](../src/pages/gift-cards/index.tsx)
- [ ] `/buzz/marketplace` — [buzz/marketplace/index.tsx](../src/pages/buzz/marketplace/index.tsx)

### P4 — Sitemaps

Must agree with per-page `deIndex` decisions (submitting a noindex URL is a
contradictory signal).

- [ ] `/sitemap-models.xml` — [sitemap-models.xml/index.tsx](../src/pages/sitemap-models.xml/index.tsx)
- [x] `/sitemap-articles.xml` — [sitemap-articles.xml/index.tsx](../src/pages/sitemap-articles.xml/index.tsx) *(2026-09-17: excludes Unsearchable and scanner-blocked articles, matching the page; see [seo-improvements.md](seo-improvements.md) §4)*
- [ ] Decide whether to add missing sitemaps: posts, bounties, collections, comics, users, events, challenges. *(Images and videos: no — those pages are `noindex`. Discovery is not a constraint, so treat any new sitemap as a curated list, not a coverage fix; see [seo-improvements.md](seo-improvements.md).)*

### Should be de-indexed (sanity-check only)

These don't need SEO polish but do need to reliably send `noindex` so they
don't clutter SERPs. Spot-check one page per group; if all members of the
group render `noindex`, tick the group.

- [ ] Edit / create / wizard routes (`articles/[id]/edit`, `articles/create`, `models/[id]/edit`, `models/[id]/wizard`, `models/[id]/model-versions/…`, `models/create`, `models/train`, `posts/[postId]/edit`, `posts/create`, `bounties/[id]/edit`, `bounties/create`, `bounties/[id]/entries/create`, `bounties/[id]/entries/[entryId]/edit`, `comics/create`, `comics/project/[id]/*`, `train`, `training/[workflowId]`, `generate`)
- [ ] Account / billing routes (`user/account`, `user/notifications`, `user/membership`, `user/buzz-dashboard`, `user/downloads`, `user/transactions`, `user/vault`, `user/referrals`, `user/earn-potential`, `user/pool-estimate`, `user/stripe-connect/onboard`)
- [ ] Auth / claim / redirect (`login`, `login/token`, `verify-email`, `redirect`, `region-blocked`, `preview-restricted`, `redeem-code`, `claim/buzz/[id]`, `claim/cosmetic/[id]`, `intent/avatar`, `intent/post`, `discord/link-role`, `studio/confirm`, `subscribe/[plan]`, `purchase/buzz`)
- [ ] Payments (`payment/*`, `tipalti/setup`)
- [ ] Collections helpers (`collections/[collectionId]/join`, `collections/[collectionId]/review`, `collections/youtube/auth`)
- [ ] Games / one-offs (`games/chopped`, `games/knights-of-new-order`, `dev/onboarding`, `data-graph-v2`, `images/iterate`)
- [ ] Moderator / internal (`moderator/*`, `research/*`, `testing/*`)

---

## Findings

### Articles — `/articles/:id/:slug?`

File: [src/pages/articles/[id]/[[...slug]].tsx](../src/pages/articles/[id]/[[...slug]].tsx)

**Status:** Fixed 2026-04-24.

- ✅ `<Meta>` outside `<SensitiveShield>`.
- ✅ `og:image` uses `/api/og?type=article&id=…`; image fallback is SFW-filtered
  by `Meta`.
- ✅ `deIndex` now also fires when `domain === 'green'` and `!hasSafeBrowsingLevel(article.nsfwLevel)`.
- ⚠️ `description` is `truncate(removeTags(article.content), 150)` — can leak
  explicit text into SERPs if an NSFW article ever slips through to the
  indexable set. Mitigated in practice by the green-domain `deIndex` guard, but
  still a risk for `.red` if we decide to index it.

---

## Open Questions

1. **Should `.red` be indexable at all?** Currently `canIndex` is true on `.red`
   based purely on host match. Indexing NSFW URLs is legitimate (there's demand
   for mature search), but it has implications for ad networks, safe-search
   compliance, and backlink profile. Decide this explicitly rather than letting
   it be a side effect of the `canIndex` = host check.
2. **Canonical format consistency.** Articles use
   `/articles/:id/:slug` as canonical with `/articles/:id` as `alternate`. Other
   entity types should follow the same convention or we should document the
   divergence.
3. **`/api/og` resilience.** The OG endpoint is the primary social image for all
   shared links. Confirm it always renders a SFW card (including for
   NSFW-but-blurred-preview cases) and that it fails gracefully (we serve
   something, not a 500, if the entity is missing).
4. **Sitemap coverage.** Do our sitemaps respect the same green/NSFW de-index
   rules as the pages themselves? A sitemapped URL that returns `noindex` is a
   contradictory signal to Google.

---

## Tooling notes

- Google Search Console is the source of truth for indexed-vs-submitted counts
  and coverage errors; pair any code finding with a GSC lookup to confirm real
  impact.
- For per-page verification, `curl -A "Googlebot" <url>` against the deployed
  site is the fastest way to see exactly what the crawler receives (meta tags
  and body copy).
- Dev-server rendering is sufficient for checking meta tags but not for
  verifying full SSR output — use a production build (`pnpm run build` +
  `pnpm run start`) when the server-render path matters.
