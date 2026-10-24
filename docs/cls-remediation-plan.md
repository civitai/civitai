# CLS Remediation Plan

Tracking the Cumulative Layout Shift (CLS) work surfaced by Google Search
Console's Core Web Vitals report (desktop; first report 2026-06-29, latest
2026-10-05). CLS measures how much
visible content jumps around as a page loads — it's both a real UX problem and a
Google page-experience ranking signal, sourced from **field data** (real Chrome
users via CrUX), not lab tests.

Scoring: `≤ 0.10` good · `0.10–0.25` needs improvement · `> 0.25` **poor**.

## Current state (Search Console desktop report, data to 2026-10-03)

64,567 desktop URLs: 9% good, 72% needs improvement, 19% poor. CLS is the whole
story — every poor URL fails on CLS (`> 0.25`), and all but 6 of the 46,533
needs-improvement URLs fail on CLS (`> 0.1`). LCP (`> 2.5s`, 10,348 URLs) overlaps
the same pages.

| Group (example URL)             | URLs   | Group CLS  | Status                                                                                      |
| ------------------------------- | ------ | ---------- | ------------------------------------------------------------------------------------------- |
| `/models/:id/:slug`             | 46,527 | 0.20       | Fixed — [streamed HTML](#field-only-shifts-streamed-html)                                   |
| `/posts/:id`                    | 4,740  | 0.35       | Fixed — [P4](#p4--detail--profile-residuals)                                                |
| `/` (homepage)                  | 3,557  | 0.64       | Fixed — [announcements](#banners--intermittent-in-the-lab-the-homepage-driver-in-the-field) |
| `/tag/:tag`                     | 1,571  | 0.59       | Open — not reproducible in the lab                                                          |
| `/user/:name/*` (tabs, profile) | 13–669 | 0.35–0.63  | Open — not reproducible in the lab                                                          |
| `/images`, `/posts`             | 99, 59 | 0.73, 0.72 | Open — see [the min-height fix](#the-fix--implemented-min-height)                           |

The model-detail group is 72% of all desktop URLs, so taking it under 0.10 moves
the property from ~9% good to ~80% good on its own. Field data is a 28-day CrUX
window, so a deploy takes about four weeks to show fully.

CrUX is real Chrome users, logged in or not — not Googlebot — so a shift that only
logged-in viewers get counts in full.

## Field-only shifts: streamed HTML

The model page scored 0.20 in the field but ~0.001 on a fast lab load. Throttled
(150ms latency, 1.6 Mbps, 4× CPU) it scored 0.21 — the browser paints the document
while it is still downloading, so any layout that depends on content later in the
HTML paints wrong first:

- The version-details sidebar comes **before** the main column in source order but
  sits on the right (`order: 2`). Parsed alone, it painted at the left edge, then
  jumped ~800px right when the main column arrived. Fix: `.sidebarSection`
  (`margin-inline-start: auto` from the `sm` container breakpoint) in
  [ModelVersionDetails.module.scss](../src/components/Model/ModelVersions/ModelVersionDetails.module.scss)
  holds it at its final slot.
- The ad rail comes **after** the content column, so until it arrived the column was
  1320px wide, then shrank to 1188px. Fix: `.withRail` is a CSS grid with an
  explicit rail track instead of flex
  (`src/pages/models/[id]/[[...slug]].module.scss`).

A fast local load cannot show this class of shift. To test for it, cut the SSR HTML
off mid-document (scripts stripped, same-origin so the CSS loads) and compare element
rects against the full document — they must match at every width.

## Reported groups, 2026-06-29 (worst first)

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

So on the feed pages (`/images`, `/posts`) the dominant lab-measured source is
**structural**, not per-tile — and (measurement below) **not the footer**: the
category chip row that renders _above_ the feed and pops in once its client-side
query resolves. The field's largest group, model detail, had a different cause
([streamed HTML](#field-only-shifts-streamed-html)).

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

> **Superseded (2026-08-19), then partly reinstated (2026-08-20).** The category tag
> filter bar was removed from every feed-like surface, and `TagScroller` and its five
> `*Categories` consumers were deleted with it (ClickUp 868ku6983). The file links
> above point at deleted paths and are kept for the record.
>
> The bar came back for **models only** (ClickUp 868kumr1c) — `/models` and
> `/user/[username]/models`, via `CategoryTags`, which never used `TagScroller` and so
> never carried the reservation this section describes. It carries its own `min-h-[26px]`
> now, in both the empty and populated states. So the shift cannot occur on any surface:
> removed from every other feed, and reserved on all three surfaces that still render
> `CategoryTags` — those two pages and the generation resource-select modal.

**Verified (local dev build, same `layout-shift` harness):**

| Page      | Before (prod field) | After (local)                         |
| --------- | ------------------- | ------------------------------------- |
| `/images` | 0.77                | **0.069** (category shift eliminated) |
| `/posts`  | 0.75                | **0.0001**                            |

The field did not follow: on 2026-10-03 the `/images` group is still 0.73 and
`/posts` 0.72 (99 and 59 URLs, so small weight). Local dev loads were fast and
whole, which hides [streamed-HTML shifts](#field-only-shifts-streamed-html) and
anything specific to logged-in viewers.

### Residual on `/images` (~0.069) — feed loading-spinner swap

After the category fix, the new (much smaller) ceiling is the feed's initial
loading state: [ImagesInfinite.tsx:214-217](../src/components/Image/Infinite/ImagesInfinite.tsx#L214-L217)
renders `<Center p="xl"><Loader /></Center>` while `!images.length && isFetching`,
then swaps it for the masonry grid (different height) → a collapse shift. Already
in the "good" band, so this is optional polish (diminishing returns). If pursued:
reserve a stable min-height for the loading state so the swap to the grid doesn't
collapse. TODO (low priority).

### Banners — intermittent in the lab, the homepage driver in the field

These render above the feed and shift when they appear post-paint. In the lab they
appeared only when active; in the field the `site` announcement was the homepage's
main shift (see the table above):

- **`MatureContentMigrationAlert`** — ✅ removed (component file + references
  deleted). One fewer above-feed injector. Only affected green-domain
  NSFW-enabled users, but still rendered post-`ready`.
- **`RewardsBonusBanner`** — gates on `useUserMultipliers()`
  ([useBuzz.ts](../src/components/Buzz/useBuzz.ts)) → `buzz.getUserMultipliers`,
  which is **not** SSR-seeded. Renders `null` while `multipliersLoading`, then
  pops in. **Fix: seed it in the `_app` bootstrap** (same mechanism that already
  seeds chat settings / announcements / feature flags). TODO.
- **`Announcements`** — ✅ fixed. Dismissals live in the `announcements-dismissed`
  cookie, which `_app` reads server-side, so the `site` banner renders in the SSR
  HTML at its true height (or not at all for a dismisser)
  ([announcements.utils.ts](../src/components/Announcements/announcements.utils.ts)).
  This path sat behind the mod-only `feedReserveCls` flag until 2026-10; everyone
  else got a 174px pop-in above the homepage feed (lab CLS 0.088). The flag is
  removed. Remaining edges (both collapse once): a dismissal made on another device is
  merged from the account only after hydration, and a user who dismissed under the
  old localStorage bundle has no cookie on their first load of the new one.

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

## P4 — Detail & profile residuals

**Status: `/posts/:id` and `/models/:id` fixed; profiles open.**

- **`/posts/:id`** — ✅ fixed. The SSR prefetch of `image.getInfinite` omitted the
  addon fields `useQueryImages` adds to its key (`excludedTagIds`, `disablePoi`,
  `disableMinor`), so the client never hit it: SSR sent a 300px "Loading Images"
  box and the post's images (~11,000px) arrived after hydration, pushing the
  comments down and delaying LCP. Both pages now build those fields with
  `getServerImageQueryFilters`
  ([browsing-level.ts](../src/server/utils/browsing-level.ts)); any new SSR prefetch
  of `image.getInfinite` should too.
- **`/reviews/:id`, `/user/:name/collections`** — not re-measured since 2026-06-29;
  absent from the 2026-10-03 report's top groups. Re-check before dedicated work.
- **`/models/:id`** — ✅ fixed, see
  [streamed HTML](#field-only-shifts-streamed-html).
- **`/user/:name/*`, `/tag/:tag`** — open. Logged in and logged out, throttled,
  scrolled deep, and across in-app navigation and back, these stay ≤ 0.02 in the
  lab against 0.35–0.63 in the field. Next step is field attribution: Faro's
  web-vitals beacons carry the largest shift's element as
  `context_largest_shift_target` in Loki — group CLS beacons over 0.1 by page URL
  and that field.

---

## P5 — `education.civitai.com` (separate property)

**Status: ROUTE TO DOCS-SITE OWNER.**

`/using-civitai-a-guide/` (0.51), `/page/2/` (0.50) are a different property
(docs/CMS), **not this Next.js app**. Classic cause there is late-loading
webfonts (no `font-display: optional` / `size-adjust`) and hero images without
dimensions. Hand off to whoever owns that site.

---

## Measurement note

Capture `layout-shift` PerformanceObserver entries (they name the moved elements)
against **production**, not local dev, and under throttling: local loads are fast
and arrive whole, so they miss streamed-HTML shifts entirely. Score with session
windows (gaps < 1s, max 5s) as CrUX does. When the lab still can't reproduce a field
number, use the Faro `context_largest_shift_target` field rather than guessing.
