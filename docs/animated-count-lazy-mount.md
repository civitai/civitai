# `AnimatedCount` — Lazy NumberFlow via State Machine

## Background

The `/images` feed renders ~30 `<ImagesCard>` components within the
`IntersectionObserver` rootMargin window (currently `'100% 0px'`). Each card
mounts a `<Reactions>` block containing **6 `<AnimatedCount>` instances**
(like, dislike, heart, laugh, cry, tipped amount), so the steady-state count
is ~180 `<NumberFlow>` custom elements active at any time.

A 2026-04-28 trace of active scrolling on `/user/<name>/images?sort=Most+Reactions`
showed:

- `getBoundingClientRect` — 781 + 174 = **955 samples** during a 14.6 s scroll
- `lite-BTIaQdTe.mjs` (NumberFlow lite bundle) — 125 samples
- `NumberFlow-client-*.mjs` (React wrapper) — 62 samples
- `clearTimeout` — ~5700 samples (cancellation churn from rapid React updates
  cascading through NumberFlow's animation orchestration)
- 92 % frame drop rate during scroll

A code comment at [src/components/Metrics/useLiveMetrics.ts:34-38](src/components/Metrics/useLiveMetrics.ts#L34-L38)
already names the failure mode:

> shallow equality is critical here: without it… every global store update
> re-renders every consumer on the page (model/image/article/creator cards
> all subscribe), causing a re-render storm + NumberFlow allocation pressure
> under signal traffic.

This document proposes a redesign of `<AnimatedCount>` that **only mounts
`<NumberFlow>` while a value is actively transitioning**, falling back to
plain text the rest of the time.

## The state machine approach

### Stages

```
┌─────────┐    value changes     ┌──────────┐    rAF      ┌────────────┐
│  idle   │─────────────────────▶│ priming  │────────────▶│ animating  │
│ <span>  │                      │<NumberFlow│             │<NumberFlow │
│         │◀─────────────────────│ value=old│             │ value=new  │
└─────────┘  onAnimationsFinish  └──────────┘             └────────────┘
```

| Stage | What renders | When entered | When exited |
|---|---|---|---|
| `idle` | Plain `<span>` with formatted text | Initial mount; after animation completes | When `value` changes |
| `priming` | `<NumberFlow value={oldValue} />` | When a value change is detected | After one `requestAnimationFrame` tick |
| `animating` | `<NumberFlow value={newValue} onAnimationsFinish={...} />` | After the priming frame | When NumberFlow fires `onAnimationsFinish` |

### Why two NumberFlow stages instead of one

NumberFlow needs to see the **previous** value first, then the **new** value,
to know what to morph from and to. If we mount it directly with the new
value, it has nothing to animate from — it appears statically with the new
value and the visual flourish is lost.

The `priming` stage exists for exactly one frame: long enough for the
custom element to attach to the DOM with the *old* value. Then the next
`requestAnimationFrame` tick swaps the value to the *new* one, which
triggers NumberFlow's `attributeChangedCallback` → `willUpdate` →
`didUpdate` → animation cascade.

### Pseudocode

```ts
type Stage = 'idle' | 'priming' | 'animating';

export function AnimatedCount({ value, abbreviate = true, animate = true }) {
  const [stage, setStage] = useState<Stage>('idle');
  const prevValueRef = useRef(value);
  // ... existing spanRef, floatingDelta state for the highlight pulse stays
  //     unchanged — it runs independently of the morph stage.

  useEffect(() => {
    if (!animate || value === prevValueRef.current) return;
    if (stage !== 'idle') return; // already in flight; let coalescing handle it
    setStage('priming');
    const id = requestAnimationFrame(() => setStage('animating'));
    return () => cancelAnimationFrame(id);
  }, [value, stage, animate]);

  // existing pulse + floating-delta effect remains here, unchanged

  if (!animate || stage === 'idle') {
    return <span ref={spanRef} className={...}>{format(value)}<floatingDelta/></span>;
  }

  if (stage === 'priming') {
    return <span ref={spanRef} className={...}>
      <NumberFlow value={prevValueRef.current} format={...} />
      <floatingDelta/>
    </span>;
  }

  // stage === 'animating'
  return <span ref={spanRef} className={...}>
    <NumberFlow
      value={value}
      format={...}
      onAnimationsFinish={() => {
        prevValueRef.current = value;
        setStage('idle');
      }}
    />
    <floatingDelta/>
  </span>;
}
```

The highlight pulse + floating "+N" indicator from the current
implementation are preserved — they run on every value change regardless of
stage, so users still see something happen even on cards where the morph is
suppressed (e.g., reduced motion).

### Edge cases

| Case | Handling |
|---|---|
| Value changes again while `animating` | The `<NumberFlow>` is still mounted; just re-render with the new value. NumberFlow internally coalesces — it'll either redirect mid-animation or chain to a new transition. We update `prevValueRef.current` only on `onAnimationsFinish` so the next priming step has the right "from" value. |
| Value changes while `priming` (sub-frame) | Race is harmless. The rAF callback in flight will fire `setStage('animating')` and the latest `value` will be in scope. NumberFlow will animate from `prevValueRef.current` to the latest value, skipping intermediate values. |
| Component unmounts during animation | rAF cleanup in the effect cancels the priming step; React unmounts NumberFlow normally. No leaks. |
| `prefers-reduced-motion: reduce` | Pass `respectMotionPreference={true}` to `<NumberFlow>`. NumberFlow internally falls back to instant updates without the FLIP animation. (Currently we pass `false` to override; this should change.) |
| Initial mount | Stage starts in `idle`, renders plain `<span>` immediately. No NumberFlow allocation on mount. This is the biggest win. |
| Rapid succession (e.g., 5 reactions in 1s) | First change → priming → animating. Subsequent changes during animating → re-render NumberFlow with new value, no stage churn. After last animation finishes → idle. Total: 1 mount, 1 unmount, 5 internal NumberFlow updates. |

### Visual consistency

The plain `<span>` and `<NumberFlow>` render slightly differently because
NumberFlow uses `font-variant-numeric: tabular-nums` internally so digits
have fixed widths (required for the morph animation to look right). Without
matching this on the plain `<span>`, the swap into `priming` will cause a
~1px width shift that catches the eye.

Mitigation: apply `font-variant-numeric: tabular-nums` to the wrapper
`<span>` so both modes render at identical width. Single CSS rule in
`AnimatedCount.module.css`.

### `void el.offsetWidth` (current line 55)

The current implementation has a deliberate forced layout to restart the
highlight CSS animation. This stays — it's a one-shot read on a known
element, not the per-frame storm we're trying to eliminate. ~1 layout per
value change is fine.

## Why NumberFlow has so much overhead

NumberFlow is built around the **FLIP animation technique** ("First, Last,
Invert, Play"), applied recursively to a tree of digit elements. FLIP is
the gold-standard pattern for animating layout changes — it's how
react-transition-group, Framer's `layout`, and most modern animation
libraries work — and it produces silky animations because the actual
animation runs on the compositor as a pure transform.

The cost is that FLIP requires **synchronous layout measurements** on every
transition. Each "frame" of an update has two layout reads:

1. `willUpdate()` — measure positions BEFORE the DOM mutates
2. (apply DOM change)
3. `didUpdate()` — measure positions AFTER the DOM mutates
4. Compute delta, schedule a transform animation that interpolates from
   the old position back to the new

For a single number, this is fine. NumberFlow's expense compounds because
it applies FLIP at *three* levels of the tree, each of which calls
`getBoundingClientRect()` independently:

```
NumberFlow root
├── willUpdate() — root.getBoundingClientRect() (line 210)
│   └── didUpdate() — root.getBoundingClientRect() again (line 216)
├── Section (integer)
│   ├── willUpdate() — section.getBoundingClientRect() (line 277)
│   ├── didUpdate() — section.getBoundingClientRect() (line 281)
│   ├── Digit '1'
│   │   ├── willUpdate() — digit.getBoundingClientRect() (line 364)
│   │   └── didUpdate() — digit.getBoundingClientRect() (line 373)
│   └── Digit '2', '3', '4' — same pattern
└── Section (fraction) — same pattern if applicable
```

For a 4-digit number with thousands separator (e.g., "1,234"), this is
roughly **~14 `getBoundingClientRect` calls per update** (2 each for: root,
1 section, 4 digits, 1 separator). At 60 fps with a single value change
animation lasting 600 ms, that's ~14 reads × ~36 frames per animation.

Why three levels? Because each level animates independently:

- Each digit slides vertically when its value changes (e.g., 4 → 5)
- Each section shifts horizontally when digits are added or removed
  (e.g., 99 → 100 grows the integer section by one digit width)
- The whole number can shift if its width changes relative to surrounding
  text (e.g., for right-aligned counters)

If any one level skipped its measurements, the animation at that level
would jitter or jump instead of morphing smoothly. The library is doing
exactly what it needs to do.

### What the `animated: false` flag does (and doesn't do)

NumberFlow exposes an `animated: boolean` prop. Setting it to `false`
gates **some** of the FLIP work — specifically, the per-digit
`willUpdate` cascade is conditionally skipped at
[lite-BTIaQdTe.mjs line 264](file:///c:/Work/model-share/node_modules/.pnpm/number-flow@0.5.8/node_modules/number-flow/dist/lite-BTIaQdTe.mjs):

```js
if (X(t, (r) => { ... }, { reverse: s }), this.flow.computedAnimated) {
  const r = this.el.getBoundingClientRect();
  e.forEach((o) => { o.willUpdate(r); });
}
```

But the **outer** `willUpdate`/`didUpdate` methods on the section and root
classes (lines 210, 216, 276, 280) run unconditionally even when
`animated=false`. So setting the flag eliminates ~30% of the per-update
gBCR cost but leaves the section + root reads in place.

A small upstream patch (early-return when `!computedAnimated` in those
two methods) would make `animated=false` honor its name fully. We could
ship that as a `pnpm patch` alongside the Mantine one, but it's only
necessary if we *keep* using NumberFlow in the always-mounted pattern.
The lazy-mount approach in this document doesn't need it because the
custom element only exists during transitions where we *want* the
animation to run.

### React wrapper overhead

`@number-flow/react` wraps the `NumberFlowLite` custom element in a React
component. The wrapper:

- Synchronizes React props with the custom element's observed attributes
  (`data`, `digits`)
- Passes through callbacks (`onAnimationsStart`, `onAnimationsFinish`)
- Uses `useCanAnimate` to track `prefers-reduced-motion`

Each mount/update flows: React update → wrapper component renders → set
attribute on custom element → `attributeChangedCallback` fires →
NumberFlow's internal update path runs. With ~180 instances on the feed,
even cheap React-level work multiplies.

### Custom element + ShadowRoot cost

NumberFlow uses a Web Component with Shadow DOM. Each instance:

- Allocates a ShadowRoot (separate DOM tree, separate style scope)
- Imports/installs internal CSS via `adoptedStyleSheets` or inline `<style>`
- Maintains its own connected/disconnected lifecycle
- Triggers separate style recalc passes from the light DOM

ShadowRoot construction is ~0.5–1 ms on typical hardware. With 180
instances on the feed, that's ~150 ms of ShadowRoot allocation just from
mounting cards as the user scrolls. The lazy-mount approach eliminates
this entirely for cards whose values don't change.

## Could we build our own NumberFlow without the overhead?

Short answer: **yes, and it would be smaller than you'd expect** — but
only if we narrow the feature set to what we actually use.

### What our use cases need

Surveying the codebase:

- `Reactions.tsx` — integer counts, sometimes compact-formatted (1k, 1.2M)
- `BuzzTippingBadge` — integer counts, no compact format
- `CurrencyBadge` — integer (buzz amount), no compact format
- `AuctionUtils` — integer

We do NOT use:

- Decimals (no fractional digits in any current consumer)
- Locale-specific number formatting (always English)
- Scientific notation
- Prefix/suffix props
- Per-digit configuration (`digits` prop)
- Custom timing (`transformTiming`, `spinTiming`, `opacityTiming`)
- Plugins (the `Plugin` system in number-flow)

This means a domain-specific replacement could drop ~70 % of NumberFlow's
surface area. Once you do that, several cheaper animation strategies
become viable.

### Approach A — CSS digit roll (no `gBCR`, all on compositor)

Render each digit position as a vertical column showing 0–9 stacked.
Show digit `n` by applying `transform: translateY(-n * 100%)`. Animate
transitions by transitioning the `transform` property.

```html
<span class="counter">
  <span class="digit" style="--n: 1"><span>0</span><span>1</span>...<span>9</span></span>
  <span class="digit" style="--n: 2"><span>0</span><span>1</span>...<span>9</span></span>
  <span class="digit" style="--n: 3"><span>0</span><span>1</span>...<span>9</span></span>
  <span class="digit" style="--n: 4"><span>0</span><span>1</span>...<span>9</span></span>
</span>
```

```css
.digit {
  display: inline-block;
  height: 1em;
  overflow: hidden;
}
.digit > span {
  display: block;
  height: 1em;
  transform: translateY(calc(var(--n) * -1em));
  transition: transform 0.4s ease;
}
```

Properties:

- **Zero layout reads.** The animation is `transform` only, runs entirely
  on the compositor.
- **Width changes (1 → 100) require a different mechanism.** Adding/removing
  digit columns triggers a real layout. Acceptable trade-off — width
  changes are rare on reactions (usually stable in their order of
  magnitude during a session).
- **No ShadowRoot.** Light-DOM only.
- **~50 lines of code.** Maybe 80 with compact formatting (1k, 1.2M).
- **Visual matches NumberFlow's "spin" mode** for the common case where
  only one or two digits change.

This is the closest match to NumberFlow's visual without any of the cost.

### Approach B — rAF interpolation (count-up style)

Use `requestAnimationFrame` to interpolate from old to new value over the
animation duration, rendering as plain text on each frame.

```ts
useAnimationFrame(({ progress }) => {
  const v = Math.round(prevValue + (newValue - prevValue) * progress);
  setDisplayValue(v);
});
```

Properties:

- **Zero layout reads.**
- **Visually counts through values:** 1, 2, 3, …, 99 instead of morphing.
- **~20 lines of code.**
- **Less satisfying than the digit roll** for small changes, but fine for
  large jumps.

This is what `react-countup` does. Could be inlined as a hook to avoid the
dep.

### Approach C — Snap + pulse (no animation library)

Snap to the new value instantly; rely on the existing CSS highlight pulse +
floating "+N" indicator to communicate that something changed.

- **Zero animation work.**
- **~5 lines of code** (just the formatter call).
- **Simplest visual** — close to what most apps do.

### Recommendation

If we go down the path of replacing NumberFlow, **Approach A (CSS digit
roll)** is the most interesting candidate. It preserves the visual
character of NumberFlow exactly for the common case (digit morphs in
place), eliminates every category of overhead we identified, and is
small enough to maintain in-tree.

But for the *immediate* fix — eliminating the per-card mount cost during
scroll — the lazy-mount state machine in the first half of this document
is the right starting point. It works regardless of which animation
library is underneath, lets us keep NumberFlow as-is for now, and gives
us a clean place to swap in a custom roll component later if we decide to.

The order I'd suggest:

1. Implement the lazy-mount state machine (this document). Ships the perf
   win immediately.
2. After validating the fix in production traces, decide whether the
   remaining NumberFlow surface area (mount cost on actual transitions) is
   worth replacing with a custom CSS digit-roll component. That's a
   separate, larger piece of work and not blocking.
