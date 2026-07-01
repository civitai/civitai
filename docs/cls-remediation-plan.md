# CLS Remediation Plan

Tracking the Cumulative Layout Shift (CLS) work surfaced by Google Search
Console's Core Web Vitals report (desktop, 2026-06-29). CLS measures how much
visible content jumps around as a page loads — it's both a real UX problem and a
Google page-experience ranking signal, sourced from **field data** (real Chrome
users via CrUX), not lab tests.

Scoring: `≤ 0.10` good · `0.10–0.25` needs improvement · `> 0.25` **poor**.

## Reported groups (worst first)

| Page template (example URL)                    | Group CLS |
| ---------------------------------------------- | --------- |
| `/images` (image feed)                         | **0.77**  |
| `/posts` (post feed)                           | **0.75**  |
| `/` (homepage)                                 | **0.65**  |
| `/tag/nsfw`                                    | **0.64**  |
| `/user/:name/images?sort=Newest`               | 0.60      |
| `/user/:name/posts`                            | 0.59      |
| `/user/:name/models`                           | 0.55      |
| `/user/:name/images`                           | 0.54      |
| `/reviews/:id`                                 | 0.52      |
| `education.civitai.com/using-civitai-a-guide/` | 0.51      |
| `education.civitai.com/page/2/`                | 0.50      |
| `/posts/:id` (post detail)                     | 0.47      |
| `/user/:name` (profile)                        | 0.39      |
| `/user/:name/videos`                           | 0.35      |
| `/models/:id/:slug`                            | 0.29      |
| `/user/:name/collections`                      | 0.27      |

## What the investigation found

The feed itself is **not** the naive "tiles reflow as images load" case. The
masonry system already does the hard part right:

- Heights are pre-computed from known image dimensions before render —
  [masonry.utils.ts](../src/components/MasonryColumns/masonry.utils.ts) computes
  `ratioHeight = (height / width) * columnWidth` and locks it into each item's
  container.
- Cards apply that fixed height inline —
  [ImagesCard.tsx](../src/components/Image/Infinite/ImagesCard.tsx),
  [PostsCard.tsx](../src/components/Post/Infinite/PostsCard.tsx).
- In-feed ad slots are pre-sized in the same pass (`createAdFeed`).

So the dominant CLS source is **structural**, not per-tile — and (measurement
below) **not the footer** either. It's the category chip row that renders _above_
the feed and pops in once its client-side query resolves.

---

## P0 — Global adhesive footer: tried, then REVERTED

Hypothesis was that the in-flow (`relative`) footer expanding 0→~90px when the ad
fills squeezed the content and shifted it, so `<AdhesiveAd preserveLayout />`
would reserve the space. **Reverted** — it doesn't hold here: the page **does not
scroll the document**. `MainContent` scrolls an internal `<ScrollArea>` and the
content row is `flex flex-1 overflow-hidden`
([AppLayout.tsx](../src/components/AppLayout/AppLayout.tsx)). The footer is a
sibling _outside_ that scroll area, so when it grows it shrinks the scroll
viewport **from the bottom**; the top-anchored feed doesn't move, it just clips
sooner. Clipping isn't a layout shift. So `preserveLayout` mostly solved a
non-problem — at the cost of an empty reserved bar in the ads-enabled-but-unfilled
case (`AdUnitRenderable` returns `null` for no-ads/blocked, so only no-fill leaves
a gap). Net negative; reverted.

## MEASURED root cause — the category row pops in above the feed

Captured real `layout-shift` entries on live `civitai.com/images` (logged-out,
headless Chromium, cache disabled). CLS across cold loads: **0.66 / 0.03 / 0.01**
— intermittent, which is exactly why the field p75 is a harsh 0.77 while many
loads are fine. When it fires, **one shift is 98.5% of the total**:

```text
shift 0.6501 @ ~0.8–3.5s
  moved:     div.flex.flex-col.gap-2.5 > div   (feed block)  y 116 → 152 (+36px), h568
  collapsed: a nested loading div                            h → 0
```

`div.flex.flex-col.gap-2.5` is the wrapper in
[images/index.tsx](../src/pages/images/index.tsx) holding `<ImageCategories />` +
`<ImagesInfinite />`. **`ImageCategories` → `TagScroller` returns `null` (0px)
until its client-side `useCategoryTags` query resolves**
([TagScroller.tsx:30](../src/components/Tags/TagScroller.tsx#L30)), then pops in a
~36px chip row and shoves the feed down. The feed is large and near the top of the
viewport, so a 36px push scores ~0.65.

Same run, for comparison: the **adhesive footer shifted only 0.0093** (P0 revert
validated), and the banners never appeared (no active event/announcement —
confirmed intermittent, not the driver).

### The fix ✅ IMPLEMENTED (min-height)

Reserved the row height in `TagScroller`
([TagScroller.tsx](../src/components/Tags/TagScroller.tsx)): the empty/loading
state now renders a `min-h-[26px]` placeholder instead of `null`, and the
populated row carries the same `min-h-[26px]` (26px = the compact-sm button row
height). The chip row can no longer pop in
and shove the feed. All five `*Categories` consumers (image / post / article /
model3d) share `TagScroller` and it has no other usages, so this one change covers
`/images`, `/posts`, `/videos`, `/articles`, `/3d-models`, and the `/user/*` tabs.

Chosen over SSR-seeding `useCategoryTags` (cleaner first paint, no reserved space,
but more plumbing) for being surgical and zero-risk.

**Verified (local dev build, same `layout-shift` harness):**

| Page      | Before (prod field) | After (local)                         |
| --------- | ------------------- | ------------------------------------- |
| `/images` | 0.77                | **0.069** (category shift eliminated) |
| `/posts`  | 0.75                | **0.0001**                            |

`/images` moved from "poor" into Google's "good" band (<0.1). Dev numbers are
noisy, but the structural before/after — the +36px category-row shift is gone —
is the reliable signal, corroborated by `/posts` going to ~0. Re-confirm on a
production build or the preview deploy; field p75 lags ~28 days.

### Residual on `/images` (~0.069) — feed loading-spinner swap

After the category fix, the new (much smaller) ceiling is the feed's initial
loading state: [ImagesInfinite.tsx:214-217](../src/components/Image/Infinite/ImagesInfinite.tsx#L214-L217)
renders `<Center p="xl"><Loader /></Center>` while `!images.length && isFetching`,
then swaps it for the masonry grid (different height) → a collapse shift. Already
in the "good" band, so this is optional polish (diminishing returns). If pursued:
reserve a stable min-height for the loading state so the swap to the grid doesn't
collapse. TODO (low priority).

### Banners — intermittent, secondary

These render above the feed too and shift when they appear post-paint, but only
when active (so not the persistent driver):

- **`MatureContentMigrationAlert`** — ✅ removed (component file + references
  deleted). One fewer above-feed injector. Only affected green-domain
  NSFW-enabled users, but still rendered post-`ready`.
- **`RewardsBonusBanner`** — gates on `useUserMultipliers()`
  ([useBuzz.ts](../src/components/Buzz/useBuzz.ts)) → `buzz.getUserMultipliers`,
  which is **not** SSR-seeded. Renders `null` while `multipliersLoading`, then
  pops in. **Fix: seed it in the `_app` bootstrap** (same mechanism that already
  seeds chat settings / announcements / feature flags). TODO.
- **`Announcements`** — its data is **already SSR-seeded**
  ([announcements.utils.ts](../src/components/Announcements/announcements.utils.ts)).
  The pop-in is NOT a data gap: `useGetAnnouncements` deliberately returns `[]`
  until `useIsClient()` to avoid a hydration mismatch against the localStorage
  `dismissed` store, and `AnnouncementsCarousel` is a `dynamic()` import. So
  preloading data won't fix it — the fix is reserving the banner's space or moving
  dismissal state server-side. TODO (needs design).

---

## P1 — `/posts` renders the whole feed only after hydration

**Status: TODO.**

[posts/index.tsx](../src/pages/posts/index.tsx) wraps `PostCategories` +
`PostsInfinite` in `<IsClient>`, which returns `null` on the server and mounts
the entire feed only after hydration — a classic post-hydration pop-in. Note
`/images` is **not** wrapped this way yet still scores 0.77, so this is additive
to P0, not the whole story.

**Options:**

- Remove the `<IsClient>` wrapper if it's no longer needed (confirm _why_ it was
  added — likely a past hydration mismatch with query-string filters).
- Or reserve a min-height placeholder matching the feed's first paint so the
  mount doesn't shift surrounding content.

**Risk:** removing `IsClient` can resurface the original hydration mismatch.
Test SSR vs. client markup with filters in the URL before shipping.

---

## P2 — Cosmetic-decorated cards get no reserved height

**Status: TODO.**

Both feed cards skip the inline height when the item has a cosmetic frame:
`style={!cosmetic?.data ? { height } : undefined}`
([ImagesCard.tsx](../src/components/Image/Infinite/ImagesCard.tsx),
[PostsCard.tsx](../src/components/Post/Infinite/PostsCard.tsx)). Those cards size
to content and shift when media loads. Affects only the subset of cards with
cosmetics, so lower impact than P0/P1.

**Fix:** give cosmetic cards a reserved height too (account for the frame's
padding/border in the masonry height calc rather than dropping the height
entirely).

---

## P3 — `EdgeImage` omits `width`/`height` attributes

**Status: TODO (cheap hardening).**

[EdgeImage.tsx](../src/components/EdgeMedia/EdgeImage.tsx) sets only `maxWidth`
via inline style; the `<img>` has no `width`/`height` HTML attributes, so the
browser can't derive an intrinsic aspect ratio before the image loads. With the
masonry box already reserved this is a minor, sub-pixel contributor — but the
dimensions are already in the data, so emitting them is low-risk hardening.

**Fix:** pass `width`/`height` attributes (from `options?.width` / `options?.height`)
onto the `<img>`. Confirm it doesn't fight the `height: 100%` / `object-fit:
cover` styling in [Cards.module.css](../src/components/Cards/Cards.module.css).

---

## P4 — Detail & profile residuals (re-measure after P0–P3)

**Status: BLOCKED on P0–P3 re-measurement.**

`/reviews/:id` (0.52), `/posts/:id` (0.47), `/user/:name` (0.39),
`/models/:id` (0.29), `/user/:name/collections` (0.27). Several embed the same
feed/card and footer paths fixed above, so re-measure before doing dedicated
work. Likely residual cause: profile/cover headers without reserved dimensions.

---

## P5 — `education.civitai.com` (separate property)

**Status: ROUTE TO DOCS-SITE OWNER.**

`/using-civitai-a-guide/` (0.51), `/page/2/` (0.50) are a different property
(docs/CMS), **not this Next.js app**. Classic cause there is late-loading
webfonts (no `font-display: optional` / `size-adjust`) and hero images without
dimensions. Hand off to whoever owns that site.

---

## Measurement note

Static analysis can't prove which source dominates the 0.77. The decisive check
is capturing real `layout-shift` PerformanceObserver entries in a browser on
`/images` and `/posts` (attributes the shift to a specific element). Worth doing
to confirm P0's impact and to re-rank P1–P4.
