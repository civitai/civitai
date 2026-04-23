# Frontend Performance Audit — April 2026

Heap snapshot + Performance profile analysis of civitai.com during a brief feed
scroll session. Captured 2026-04-22 by Justin (logged out, Chrome). Analyzed by
Claude Code by parsing the raw snapshot/trace JSON (see
`.claude/worktrees/perf-heap-fixes/docs/` and the scripts in `C:\tmp\perf-analysis`
if you want to re-run).

> **Caveat.** The capture was logged out — no websocket signals, no live
> metrics, no chat, no notifications. Every number below is a floor, not a
> ceiling. A logged-in capture will amplify the store/observer/animation paths.

> **Branch offset.** `main` (what civitai.com runs) does NOT yet include
> `343778e1a ModelCard optimizations` or the other unreleased work on this
> branch. Some fixes described below are already landed in this branch
> ahead of main — see "Status" markers. Relatedly, there is a separate
> [feed-card-dom-audit.md](./feed-card-dom-audit.md) by Briant covering DOM
> reduction + render cost at feed scale; the two audits are complementary.

---

## TL;DR

- **+29MB heap after a brief scroll** (61MB → 90MB fresh → scroll).
- **26,839 detached DOM nodes** (was 3). Real leak, not just churn.
- **3,920 150-ms `setTimeout`s** installed in 102s (38/sec) from one app
  chunk — a debouncer is being reset every scroll tick.
- **One `requestAnimationFrame` loop runs at 60Hz the whole time** the feed is
  open, driving `Layerize` (1,627×), `Paint` (4,189×).
- Feed cards use the `@number-flow/react` library (`AnimatedCount` /
  `LiveMetric`) for every metric. Each instance spawns a custom element +
  ShadowRoot + ~10 digit spans + 4-6 `CSSStyleDeclaration`s.
- A `PerformanceObserver` is running with `buffered: true` and never clears —
  `PerformanceEventTiming` entries leak linearly.

---

## Heap diff: fresh → brief feed scroll

| Metric | Fresh | After scroll | Δ |
| --- | ---: | ---: | ---: |
| Total self size | 61.3 MB | 90.4 MB | **+29.1 MB** |
| Node count | 1,385,045 | 2,179,815 | +794,770 |
| Detached DOM | 3 | **26,839** | +26,836 (+3.5 MB) |

### Top size-growth constructors

| Constructor | Δ count | Δ size |
| --- | ---: | ---: |
| `object::Object` | +174,919 | +5.24 MB |
| `array::(object elements)` | +48,487 | +2.14 MB |
| `object::uW` (minified) | +16,131 | +1.61 MB |
| `array::(object properties)` | +10,526 | +1.54 MB |
| `closure::` | +46,035 | +1.32 MB |
| `object::system / Context` | +42,691 | +1.24 MB |
| `native::Text` | +13,558 | +1.23 MB |
| `native::CSSStyleDeclaration` | +19,365 | +1.13 MB |
| `native::SVGPathElement` | +3,091 | +0.52 MB |
| `native::V8EventListener` | +12,358 | +0.49 MB |
| `native::DOMTokenList` | +7,077 | +0.41 MB |
| `native::PerformanceEventTiming` | +1,381 | +0.36 MB |

### AnimatedCount / NumberFlow footprint

During the same scroll:

- `ShadowRoot` 249 → 1,164 (+915)
- `native::<span class="digit__num" inert style="--n: 0..9">` — each digit added
  ~1,100–1,500 instances. Across 0–9 that is ~10k digit spans.
- `native::<span class="AnimatedCount_wrapper__mdpqx">` 245 → 1,150 (+905)
- `native::SVGAnimatedLength/Transform/String/Number/Rect/PreserveAspectRatio` —
  each grew by ~4,100 (SVG icons inside `NumberFlow` shadow DOM + Tabler icons
  on cards)

The library is cool. It is extremely expensive at card-grid scale.

---

## CPU profile (102s trace)

| Metric | Value |
| --- | ---: |
| Sum of X events | 102.1 s |
| Long tasks (≥50 ms) | 91 |
| Heaviest 6 tasks | 180–225 ms each (React commits, chunk `30548-*.js`) |
| `scroll` events dispatched | 560 (avg 4.3 ms each, total 2.4 s) |
| `rAF` service calls (`PageAnimator::serviceScriptedAnimations`) | 1,627 |
| `Layerize` | 1,627× (7.9 s total) |
| `Paint` | 4,189× (1.54 s total) |
| `IntersectionObserver::computeIntersections` | 3,316 calls |

### Timer churn

Top `TimerInstall` callsites (102 s window):

| Count | Timeout | Source |
| ---: | ---: | --- |
| **3,920** | 150 ms | `civitai.com/_next/static/chunks/30548-8821e4834a2871a8.js:4` |
| 559 | 300 ms | `civitai.com/_next/static/chunks/pages/_app-4a3afcd97c94cf70.js:11` |
| 68 | 100 ms | `_app-*.js:11` |
| 41 | 500 / 5000 ms | Snigel ad engine |
| 34 | — | 34 `requestAnimationFrame` registrations also bound to `_app-*.js:11` |

4,718 timers installed, 479 fired, 10,344 removed. The ratio screams
**debouncer reset storm**: almost every install gets cancelled and replaced.

### EventDispatch breakdown

| Type | Total | Count | Avg |
| --- | ---: | ---: | ---: |
| scroll | 2,401 ms | 560 | 4.3 ms |
| wheel | 36 ms | 221 | 0.16 ms |
| pointermove | 31 ms | 260 | 0.12 ms |
| load | 21 ms | 292 | 0.07 ms |

Scroll handlers are doing 4 ms of JS per event. That is where the 150 ms
debouncer is getting reset 38 times per second.

---

## Root causes — what's actually going on

### 1. NumberFlow in every card is a DOM bomb

`src/components/Metrics/AnimatedCount.tsx` wraps `@number-flow/react`, which is
a web component with shadow DOM and per-digit rAF animation. It is used via
`LiveMetric` across 16 components, including `ArticleCard`, `ModelCard`,
`ImagesCard`, `CreatorCardSimple`, `UserStatBadges`, `Reactions`,
`ModelVersionDetails`. Each card renders 4–7 metrics. A 50-card feed = 200–350
NumberFlow instances = 200–350 shadow roots, thousands of digit spans, a
permanent 60Hz rAF loop.

This is the #1 contributor to the `ShadowRoot`, `digit__num`, `CSSStyleDeclaration`,
`Layerize`, and `Paint` growth.

### 2. Per-card IntersectionObserver instead of shared

`src/components/Metrics/MetricSubscriptionProvider.tsx:77-90` creates a brand
new `IntersectionObserver` for every card. The repo already has a shared one
(`src/components/IntersectionObserver/IntersectionObserverProvider.tsx`) that
multiplexes observations through a single observer. Using the shared provider
here would cut `computeIntersections` by ~30×.

Equally important: per-card observers that aren't guaranteed to unsubscribe
before the card unmounts are a likely source of the 26,839 detached nodes.

### 3. 150 ms scroll debouncer in chunk `30548`

Every scroll tick (560 over 102 s) resets a 150 ms `setTimeout`. That chunk is
a big aggregated app chunk; the exact module will need a source-map lookup or
`grep setTimeout.*150` with scroll-adjacent surrounding code. Candidates from
the repo:

- `MasonryProvider` + `useBrowsingLevelDebounced` recompute `items` in
  `MasonryGridVirtual.tsx:61–78` whenever the debounced browsing level fires.
- `createAdFeed` re-slots ads.
- Any Mantine `useDebouncedValue(..., 150)` in a scroll-adjacent component.

### 4. Stuck `PerformanceObserver`

`PerformanceEventTiming` +1,381 entries per short session, +0.36 MB/session.
Somewhere we registered `new PerformanceObserver({ type: 'event', buffered: true })`
and never call `takeRecords()` or `disconnect()`. Classic observability leak —
probably web-vitals instrumentation.

### 5. Tabler icon explosion

`SVGPathElement` +3,091, `SVGSVGElement` +1,040, 6 different `SVGAnimated*`
growing +4,100 each. Every Tabler `<IconX />` is an inline SVG tree with
animated attributes. Feed cards inline 15–25 icons each; no memoization, so
they're re-created on every parent render. Mid-term fix: SVG sprite. Short
term: `React.memo` the card.

### 6. Minified `object::uW` (+16k, +1.6 MB)

Most likely `@tanstack/react-query`'s `QueryObserver`. Suggests unstable
`queryKey` shapes (object literals created per render) or unbounded infinite
query cache. Needs source-map lookup to confirm.

---

## Fix plan (priority order)

### P0

1. **Gate `AnimatedCount` to visible cards.** Render a plain formatted number
   when offscreen; only instantiate `NumberFlow` when the card is intersecting.
   Halves DOM size and kills the always-on rAF loop. **Status: done in this
   branch (`perf(metrics): gate NumberFlow animation to visible cards`).**
2. **Switch `MetricSubscriptionProvider` to the shared
   `IntersectionObserverProvider`.** One observer for the feed instead of one
   per card. Fixes `computeIntersections` churn and a detached-node vector.
   **Status: already done in this branch via `343778e1a ModelCard optimizations`
   (not yet in prod).**
3. **~~Find and disconnect the stuck `PerformanceObserver`.~~** Investigated
   — no `PerformanceObserver` registration in our source (`rg "new PerformanceObserver"` empty; no `web-vitals` / `@sentry` / `@vercel/analytics` /
   `posthog` deps). The `+1,381 PerformanceEventTiming` retention is coming
   from a third-party script, most likely Snigel's ad engine
   (`adengine.snigelweb.com/.../adngin.js` was the #2 TimerInstall source and
   regularly probes INP for bid quality) or a browser extension that was
   loaded during the capture (React DevTools + Metamask content scripts were
   present). **Status: not in our code — no fix available from our side.**
   If we add our own perf instrumentation later, be sure to disconnect
   observers on page unload.
4. **~~Track down the 150 ms scroll debouncer.~~** Found it:
   `@tanstack/virtual-core`'s scroll listener ends scrolling via an
   internal `debounce(..., isScrollingResetDelay)` (default **150 ms**).
   The scroll `handler` calls `fallback()` on every scroll event, which
   resets the timer — reinstalling one `setTimeout(150)` per scroll tick.
   The three `useVirtualizer` callsites (`MasonryGridVirtual`,
   `MasonryColumnsVirtual`, `pages/user/downloads.tsx`) are the source of
   the 3,920 timer installs. **Status: fixed in this branch — all three
   now pass `useScrollendEvent: true`**, opting into the native `scrollend`
   event (Chrome 114+, Firefox 109+, Safari 18.2+). virtual-core falls back
   to the 150 ms debounce automatically on older browsers.

### P1

5. **`React.memo` feed card components with stable prop references.** Avoids
   re-rendering every card on unrelated store updates.
6. **Memoize inline Tabler icons** (or move to a sprite sheet). 1000 SVG trees
   per 50-card feed is cheap to kill.
7. **Audit `uW` observer (queryKey stability).** Either a source-map lookup or
   dev-build sanity check; look for `{ ... }` object literals in `queryKey`.

### P2

8. Audit `useSignalTopic` cleanup when topic becomes undefined.
9. Drop NumberFlow animation entirely for low-motion metrics (downloads, likes);
   use CSS pulse on value change instead.
10. `MasonryGridVirtual.tsx:61` — `useBrowsingLevelDebounced` + `adsReallyAreEnabled`
    cause `items` recompute every debounce fire. Guard with `useMemo` key stability.

---

## Next capture (please)

- Logged-in session, same pattern: fresh snapshot → 60 s feed scroll → second
  snapshot → 60 s idle → third snapshot.
- Same 30-60 s Performance trace, "scroll feed" only (no navigation) for
  cleaner data.

Expected amplification when logged in:

- Signal websocket + `useMetricSignalsStore` deltas → every card re-renders on
  every delta (even with `useShallow`, the `MetricSubscriptionContext.Provider`
  value is new each render — see point 1 of P1 above).
- Notification + chat signalr loops → more rAFs and timers.
- `object::uW` and detached DOM will likely explode further.

---

## Reproducibility

Raw artifacts live in `C:\Users\Zipp4\Downloads\perf\`:

- `fresh.heapsnapshot` (125 MB)
- `brief feed scroll.heapsnapshot` (196 MB)
- `sitting for 5 minutes in background.heapsnapshot` (163 MB, **truncated —
  unusable**)
- `Trace-20260422T191137.json` (160 MB)

Analyzer scripts in `C:\tmp\perf-analysis\`:

- `analyze-heap.mjs` — aggregates nodes by (type, constructor), writes
  `<name>.summary.json`.
- `diff.mjs` — diffs two summary JSONs.
- `analyze-trace.mjs` — event categories, long tasks, rendering pipeline.
- `find-timer.mjs` — groups TimerFire by timerId, dumps TimerInstall stacks.
- `timer-stats.mjs` — TimerInstall frequencies by callsite, rAF callsites,
  EventDispatch by type, install/fire/remove counts.

Run with `node --max-old-space-size=12288 analyze-heap.mjs <file>`.
