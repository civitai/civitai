# Feed `Layerize` — Investigation Notes & Remaining Levers

This document captures what we've learned about `Layerize` cost on Civitai's
infinite-scroll feed pages (`/images`, profile feeds, model feeds, etc.)
and the levers still available to reduce it. It's the companion to:

- [feed-layer-perf-checklist.md](feed-layer-perf-checklist.md) — the original
  three-item checklist (content-visibility, image right-sizing, Mantine patch)
- [animated-count-lazy-mount.md](animated-count-lazy-mount.md) — analysis of
  why NumberFlow was expensive
- [custom-number-flow-plan.md](custom-number-flow-plan.md) — implementation
  plan for the in-house replacement

This doc focuses specifically on the **compositor `Layerize` step** as a
recurring problem and the structural changes that affect it. JS-side
optimizations (already addressed) are covered in the other docs.

## What `Layerize` is and why we care

`Layerize` is Chromium's main-thread step that walks the render tree and
decides which elements should become their own composited layers. It runs
when:

- Compositing reasons change (something gains or loses `will-change`,
  `transform`, `filter`, `opacity` < 1, an active animation, etc.)
- Layer overlap analysis needs to recompute (a non-promoted element
  overlapping a promoted layer may need to be implicitly promoted)
- DOM mutations affect the layer tree
- A layer's bounds change

Its cost is roughly proportional to the size and complexity of the layer
tree under the changed subtree. A single big `Layerize` at a quiet moment
is fine. Many `Layerize`s per second on a large layer tree starves the
main thread and drops frames.

The original investigation (2026-04-28) measured 4716 ms of `Layerize` over
a 13.8 s production idle trace — 34 % of wall time on a page where the user
was just moving the mouse around. Multiple subsequent regressions and
fixes revealed that the feed has several independent sources of
`Layerize` work that compound.

## Known sources, in approximate order of contribution

### 1. The `.scroll-area` ~500 MB composited layer

Defined at [src/styles/globals.css:485-492](src/styles/globals.css#L485-L492):

```css
.scroll-area {
  overflow-x: hidden;
  will-change: transform;
  position: relative;
  scrollbar-width: thin;
  display: flex;
  flex-direction: column;
}
```

`will-change: transform` forces the entire scrollable region into a single
composited tile sized to its full `scrollHeight`. On the `/images` profile
feed this measures ~500 MB in the DevTools Layers panel (estimate). Any
`Layerize` event that has to walk this layer pays in proportion to its
size; that's why per-event `Layerize` cost is consistently higher than on
non-feed pages.

We tried removing `will-change: transform` on 2026-04-28 and saw scroll
smoothness regress. The cause turned out to be a confound — non-passive
touch listeners from Mantine's `useClickOutside` were marking the layer as
a slow-scroll region. After the Mantine patch we never re-tested the
`will-change` removal under cleaner conditions; this is still the largest
unrealized win on the table (see "Levers still on the table" below).

### 2. Compositor-friendly CSS animations on overlapping elements

Four infinite CSS animations were running on every page load (SupportButton
pulse + bounce, RewardsBonusBanner gradient + shimmer). Each animated
properties that aren't compositor-friendly (`box-shadow`,
`background-position`), so each frame triggered a main-thread paint. Because
those elements visually overlap the giant `.scroll-area` layer, every paint
re-ran overlap analysis against the 500 MB layer.

**Status: fixed.** All four elements now have `will-change: transform` so
their per-frame paint stays inside their own promoted layers. After the
fix, `AnimationFrame::Render` count went from 882/13.8s → 0/10.7s in
production traces.

There's a fifth animation we haven't located yet — `button-highlight`
animating `background-position`, found in a 2026-04-29 DOM scan. See
"Outstanding investigation" below.

### 3. CustomNumberFlow stack promotion storm

Every `<AnimatedCount>` instance on the feed renders multiple digit
columns, each containing a `.stack` span that translates vertically to
show the current digit. The first implementation set
`will-change: transform` on `.stack`, which permanently promoted every
single digit to its own composited layer.

With ~30 active cards × 6 reaction counts × ~1–4 digits each, this
amounts to **400+ permanently-promoted layers** across the feed. Every
`Layerize` event had to walk all of them.

**Status: fixed (2026-04-29).** Removed `will-change: transform` from
`.stack` in
[src/components/Metrics/CustomNumberFlow.module.css](src/components/Metrics/CustomNumberFlow.module.css).
The `transition: transform` rule remains, so Chrome will still promote a
stack for the duration of an active digit roll and demote it
afterwards — the layer storm goes away during idle, when nothing is
animating.

### 4. Mantine `useClickOutside` non-passive `touchstart` listeners

Every Mantine `Popover` (the underlying primitive of `Menu`, `HoverCard`,
`Combobox`, etc.) registered a non-passive `touchstart` listener on
`document`, regardless of whether the popover was open. With ~30 `Menu`
instances mounted across feed cards, this stacked ~30+ document
listeners and triggered Chromium's "Slow scroll regions with many touch
event handlers" promotion of the feed layer.

**Status: fixed.** A `pnpm patch` against `@mantine/hooks` makes
`useClickOutside`'s `touchstart` listener passive. Same bug exists in
v8.3.18 and v9.1.1, so the patch survives upgrades. See
[patches/@mantine__hooks.patch](../patches/@mantine__hooks.patch).

### 5. Content-visibility on virtualized rows

Each row in `MasonryColumnsVirtual` uses `content-visibility: auto` plus
`contain-intrinsic-size`, telling the browser to skip layout/paint for
offscreen overscan rows. This is a real win on its own — but it also
means every row has its own implicit IntersectionObserver
(`content-visibility: auto`'s internal mechanism) plus our explicit
`useInView` IntersectionObserver. The two compound.

**Status: shipped, complementary, but worth a controlled test.** If
post-fix traces still show elevated `Layerize` at idle, removing
`content-visibility: auto` and re-tracing is the next experiment. It may
trade scroll-time benefit for idle compositor cost.

## What this looks like in numbers

Production idle traces on the same page:

| Date | `Layerize` total | Events | Mean per event | Frame drop rate |
|---|---:|---:|---:|---:|
| 2026-04-28 baseline | 4716 ms / 13.8 s (34 %) | 440 | 10.7 ms | 50 % |
| 2026-04-28 post-deploy (CustomNumberFlow with `will-change`) | 8522 ms / 10.7 s (79 %) | 374 | 22.8 ms | 75 % |
| 2026-04-29 expected post-`will-change` removal | TBD | TBD | TBD | TBD |

The interim regression (Apr 28 post-deploy) shows clearly how a
seemingly-safe `will-change` declaration on small elements (digit stacks)
can multiply the layer count by ~50× and double per-event `Layerize`
cost. **Lesson:** any new `will-change` declaration in a feed-page
component should be reviewed for instance count before merging.

## Levers still on the table

Roughly ordered by impact-per-effort.

### A. Re-attempt removing `will-change: transform` from `.scroll-area`

The biggest single potential win. The 500 MB layer is the upper bound on
per-`Layerize` cost; without it, Chrome auto-tiles the scrollable area
based on visible content rather than backing the full scrollHeight as
one texture.

Conditions are now substantially different from the failed 2026-04-28
attempt:

- Mantine `useClickOutside` listeners are passive (no slow-scroll-region
  marker)
- The four animation overlaps are gone (no per-frame overlap thrashing
  against the layer)
- The CustomNumberFlow stack-layer storm is gone

This is essentially the only change that *could* make things worse on
the new baseline, so it's worth a controlled test under clean
conditions.

**Test plan:**

1. Create a branch removing `will-change: transform` from `.scroll-area`.
2. Capture an idle and a scrolling trace on `civitai.red`.
3. Compare against the post-fix baseline (the next idle trace
   captured after the `.stack` `will-change` removal).
4. Specifically watch for:
   - Layer memory estimate on the feed scroll-area (target: drops to
     viewport-tile-sized, well under 100 MB)
   - Scroll smoothness on touch devices (the only thing that ever
     regressed here historically)
   - "Slow scroll regions" warning re-appearing (signals an unfound
     non-passive listener still around)

**Tradeoff:** if scroll feel still regresses, we know there's another
non-passive listener source we haven't found. The detection script
(`['touchstart','touchmove','wheel'].forEach(...)` from the Mantine
patch validation) will surface it.

### B. Locate and fix the `button-highlight` animation

A 2026-04-29 DOM scan revealed an unaccounted infinite animation:

```
'button-highlight' 'background-position'
```

`background-position` is not compositor-friendly, so this re-paints the
animating element on every frame. If the element is mounted globally
(header, sidebar, AppLayout) or on every card, it has the same
overlap-analysis effect as the four animations we already fixed.

**Steps:**

1. Find the element: `document.querySelectorAll('*').forEach((el) => { if (getComputedStyle(el).animationName === 'button-highlight') console.log(el); });`
2. Grep the codebase for the keyframes: `grep -rn "@keyframes button-highlight" src/`
3. Apply the same fix pattern as SupportButton: add `will-change: transform`
   directly to the animating element so its repaint stays in its own
   composited layer.

This is small but structurally identical to the SupportButton fix we
already shipped.

### C. Per-row `contain: layout paint` for stronger isolation

`MasonryColumnsVirtual` already adds `content-visibility: auto` per row.
Adding `contain: layout paint` (or even just `contain: paint`) to the
same wrappers would give stronger isolation: changes inside one row's
subtree (image decode, hover state, NumberFlow value change) would not
invalidate the parent feed layer's overlap analysis.

**Important caveat:** `contain: paint` was *previously rejected on the
parent `.scroll-area`* per saved memory notes. That rejection applies to
the parent specifically. **On individual rows it's structurally
different:**

- Each row is small (one card-sized box), so the per-layer cost is tiny
- The isolation benefit is real
- It does not interact with the parent scroll-area's promotion

Test this only if Lever A doesn't fully resolve `Layerize` cost.

**Implementation:** single-line addition to the row wrapper style in
[src/components/MasonryColumns/MasonryColumnsVirtual.tsx:132-146](src/components/MasonryColumns/MasonryColumnsVirtual.tsx#L132-L146).

### D. Tighten `IntersectionObserverProvider` rootMargin

[src/components/IntersectionObserver/IntersectionObserverProvider.tsx:153](src/components/IntersectionObserver/IntersectionObserverProvider.tsx#L153)
sets `rootMargin: '100% 0px'`. That counts ~3× viewport-height of cards
as "in view" for live-metric subscription purposes. Tightening to
`'25% 0px'` or `'0px'` reduces:

- Active live-metric subscriptions
- NumberFlow allocation pressure during signal traffic
- Forced layouts during scroll

The trade-off is more "0 → real value" flicker as cards enter view if a
metric updated while they were offscreen. Server-fetched initial values
mean this is bounded.

This is independent of `Layerize` directly — it reduces the
*per-signal-fan-out* cost. Mentioned here because it interacts with
several feed-page costs at once.

### E. Verify content-visibility's net effect

`content-visibility: auto` on each row was added under the assumption
that the per-row paint isolation outweighs the per-row implicit
IntersectionObserver overhead. The 2026-04-28 post-deploy trace had
elevated IO compute time (93 ms vs 43 ms baseline) which could indicate
the implicit observers are contributing.

**Test plan:**

1. Branch removing `contentVisibility: 'auto'` and `containIntrinsicSize`
   from the virtualized row wrapper
2. Capture idle + scrolling traces and compare to the latest baseline
3. If `Layerize` total drops, content-visibility is net negative on
   compositor cost (and we'd weigh that against scroll-time benefit it
   provided)
4. If `Layerize` total stays the same or rises, content-visibility was
   working correctly and we leave it in place

This is a lower-priority experiment — only worth doing if Levers A and C
don't fully resolve `Layerize` cost.

### F. Image decoding stabilization

Each `<img>` finishing decode mid-scroll can trigger `Layerize` on its
parent (a new image bitmap layer is added to the tree). Ensuring all feed
images use `decoding="async"` and `loading="lazy"` keeps decode work off
the scroll-tick path.

**Check:** [src/components/EdgeMedia/EdgeImage.tsx](src/components/EdgeMedia/EdgeImage.tsx)
and the image rendering inside `EdgeMedia2` for these attributes. Add
them if missing.

Smaller win individually but compounds across many cards.

### G. Subscription debouncing during scroll

Cards mounting/unmounting during scroll trigger `topic:register` and
`topic:unsubscribe` messages to the signals worker. The worker
forwards these to the SignalR hub. Rapid scroll = rapid subscription
churn. We didn't get a clean prod measurement of this rate before the
local instrumentation was reverted, but on production the trace's 348
worker port-messages/sec (2026-04-28) suggests it's significant.

A 250 ms debounce on `releaseTopic` in `SignalsProvider` would smooth
this:

- A card scrolls out → schedule release in 250 ms
- The same card scrolls back into the rootMargin within 250 ms →
  cancel the release; no churn
- Otherwise → release after the delay

Doesn't directly affect `Layerize` but it reduces the per-frame React
re-render fan-out that compounds with `Layerize` to drop frames.

## Outstanding investigation

Items where we don't yet have enough information to decide:

- **`button-highlight` source** (Lever B above) — needs a quick locate
  step before a fix can ship.
- **Production worker message volume breakdown** — local instrumentation
  was reverted, and the local hub doesn't connect, so we still don't
  know whether the 348 msg/sec we measured in production is dominated by
  subscription churn (Lever G), real metric traffic (server-side
  rate-limit), or another signal type. To answer this, the
  instrumentation would need to be deployed to staging or temporarily to
  prod — see commit history for the instrumentation diff if needed.
- **Layers panel compositing reasons after the `.stack` fix** — at the
  next idle trace, screenshot the Layers panel and note any unexpected
  compositing reasons. The 500 MB scroll-area layer should still be
  there; check whether anything else pops up.

## Things we've ruled out

For future readers, options that have been considered and explicitly
rejected:

- **Switching to a windowed virtualizer** (translate-based, no spacer) —
  rejected as too large a departure from the masonry style and feel.
- **Paging the feed** with bucket boundaries — rejected on UX grounds.
- **`contain: paint` on the parent `.scroll-area`** — rejected by user
  memory note; superseded by per-row containment in Lever C.
- **JS-toggled `will-change` on `.scroll-area`** — tried, rejected.
  The toggle creates a visible Layers-panel transition (small layer →
  full feed layer) on each scroll start. The cost wasn't avoided, just
  deferred to scroll-start, which felt worse than always-on.
- **Removing `@number-flow/react` entirely from `package.json`** — kept
  installed pending validation that `CustomNumberFlow` covers all
  consumer needs. Removal is a follow-up after `CustomNumberFlow` is
  proven in production.

## Decision rules for future contributors

Adding to a feed-page component? Quick checklist before merging:

1. **No new `will-change` declarations** without measuring the instance
   count. If the element renders >50× per page, `will-change` on it is
   probably wrong; let the browser decide.
2. **No new infinite CSS animations** on properties that aren't
   compositor-friendly (`background-position`, `box-shadow`,
   `top`/`left`, etc.). If you must, promote the animating element with
   `will-change: transform` so its repaint stays in its own layer.
3. **No new non-passive `touchstart`/`touchmove` listeners** on
   `document` or `window`. They mark whatever scroll region they're on
   as a slow-scroll region.
4. **New custom elements with ShadowRoot are expensive at scale.** Each
   one allocates a separate DOM tree and style scope. 100+ instances on
   a feed page is a perf cliff.
5. **Check that `decoding="async"` and `loading="lazy"`** are set on any
   `<img>` you add to a card.

When in doubt, capture a 10 s idle trace on the affected page and
compare `Layerize` totals before/after the change.
