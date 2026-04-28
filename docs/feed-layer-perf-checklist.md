# Feed Layer Performance — Cap Memory & Compositor Cost

Follow-up to a 2026-04-28 trace on `civitai.red` showing the main feed
`.scroll-area.flex-1.@container` layer at ~500 MB with the warning
*"Overlaps other composited content"* and *"Slow scroll regions with many touch
event handlers"*. Promoting the four header/sidebar animations into their own
layers is already done (see commit applying `will-change: transform` to
`SupportButton` + `RewardsBonusBanner`).

This document tracks the remaining levers for capping the feed layer's
backing memory and reducing per-Layerize cost. None of these require switching
virtualization libraries, paging the feed, or breaking the masonry style.

The feed renders through [src/components/MasonryColumns/MasonryColumnsVirtual.tsx](src/components/MasonryColumns/MasonryColumnsVirtual.tsx)
using `@tanstack/react-virtual` with a per-column total-height spacer pattern
(line 128: `height: rowVirtualizer.getTotalSize()`).

---

## 1. `content-visibility: auto` per virtualized item

### What it does

Tells Chromium to skip layout, paint, and rendering work for any subtree that
is currently outside the viewport. Combined with `contain-intrinsic-size`, it
reserves layout space without painting it.

For a virtualized feed this provides two wins beyond what virtualization
already gives us:

1. **Paint isolation** — each row becomes its own paint subtree, so a single
   row's repaint (e.g. an image finishing decoding, a hover state, a Menu
   opening) does not invalidate the entire scrolling-contents layer.
2. **Overscan rows aren't fully painted** — `overscan: 5` (line 77) keeps 5
   rows above/below mounted; today they paint normally and contribute to the
   layer's used texture area. With `content-visibility: auto`, the browser
   paints them only if/when they enter the viewport.

### How we applied it

**Status: applied to `MasonryColumnsVirtual` only.** Skipped on
`MasonryGridVirtual` because that virtualizer measures row height from the
DOM (`measureElement: (el) => el.getBoundingClientRect().height` at
[MasonryGridVirtual.tsx:118](src/components/MasonryColumns/MasonryGridVirtual.tsx#L118)),
and `content-visibility: auto` collapses offscreen subtrees so the
ResizeObserver feeding `measureElement` would observe a spacer-shaped
height as rows scroll out and feed it back to the virtualizer. The
`MasonryColumnsVirtual` path is safe because its row div has an explicit
`height: items[item.index].height` style which `content-visibility` cannot
override.

Diff that landed at
[MasonryColumnsVirtual.tsx:132-146](src/components/MasonryColumns/MasonryColumnsVirtual.tsx#L132-L146):

```diff
       {rowVirtualizer.getVirtualItems().map((item) => (
         <div
           key={`${item.index}_${item.key}`}
           style={{
             position: 'absolute',
             top: 0,
             left: 0,
             width: '100%',
             height: items[item.index].height,
             transform: `translateY(${item.start - rowVirtualizer.options.scrollMargin}px)`,
+            contentVisibility: 'auto',
+            containIntrinsicSize: `0 ${items[item.index].height}px`,
           }}
         >
```

If we ever want the same win on `MasonryGridVirtual`, the safe path is to
make its row height explicit (read `virtualRow.size` from the virtualizer
into the row div's `height` style and stop relying on `measureElement`),
*then* apply the same `content-visibility` pair. Out of scope for now.

### Validation — item 1

- [x] Apply diff to `MasonryColumnsVirtual.tsx`
- [ ] Re-record a 10s trace on `/user/<name>/images` while idle. Confirm that
      `Layerize` total drops further (target: <500 ms over 10s).
- [ ] Confirm scroll feel hasn't regressed — the browser may briefly show a
      blank row before paint completes if you scroll faster than paint can
      keep up. Tune `overscan` if so.
- [ ] Spot-check that hover/focus rings, Mantine Popover positioning, and
      ImageContextMenu still render correctly inside `content-visibility: auto`
      (the property creates a containment context).

### Risks / known caveats — item 1

- `content-visibility: auto` creates a **containment boundary** — anchored
  positioning, focus traversal, and `getBoundingClientRect` of children
  outside the viewport may behave subtly differently. Most should still work,
  but verify Mantine `Popover withinPortal` (the popover root element is
  outside the contained area, so positioning math against the trigger should
  still resolve correctly).
- Bookmark scrolling / `scrollIntoView` on offscreen items should still work
  because layout *space* is reserved via `contain-intrinsic-size`.

---

## 2. Right-size feed images to the rendered column width

### Background

[src/components/Image/Infinite/ImagesCard.tsx:135](src/components/Image/Infinite/ImagesCard.tsx#L135)
hard-codes `width={450}` on the card's `EdgeMedia2`. The masonry column width
is typically 320 px (single column) or `useMasonryContext().columnWidth`
(multi-column). At 320 px column width, a 450 px-wide source is **~2×
oversized**.

The decoded bitmap memory of an image scales with `W × H × 4 bytes`
regardless of file size. A 450×600 image decodes to ~1080 KB in memory; a
320×427 image decodes to ~547 KB. Across ~60 visible cards in the feed,
that is roughly **30 MB of decoded image memory we can drop** without any
visible quality change at typical column widths.

This savings doesn't move the *layer memory estimate* directly (that's a
function of layer dimensions × DPR² × 4), but it cuts the GPU image-decode
cache pressure that compounds with the layer cost.

### Code change — item 2

Pass the actual rendered column width into `EdgeMedia2` instead of a constant:

```diff
+import { useMasonryContext } from '~/components/MasonryColumns/MasonryProvider';
@@
 export function ImagesCard({ ... }) {
+  const { columnWidth } = useMasonryContext();
@@
                     <EdgeMedia2
                       …
-                      width={450}
+                      width={Math.ceil(columnWidth * 1.25)}
```

`× 1.25` keeps a small upscale buffer for slight DPR mismatches and zoom,
without going all the way to 2× DPR. For users on hi-DPI displays who notice
softness, we can revisit (it's still sharper than today's behavior on a 2×
display, since `width=450` displayed in a 320 column already over-downscales
on hi-DPI).

### Validation — item 2

- [ ] Apply the change.
- [ ] Confirm that on a typical desktop layout the requested URLs go from
      `width=450` to roughly `width=400`.
- [ ] Re-check Memory pressure in the Layers panel — total image-decode
      memory in the page should drop by ~30 % on a fully-scrolled feed.
- [ ] Visually compare a side-by-side: before/after at 1× and 2× DPR. If 2×
      looks visibly soft, raise the multiplier to `1.5`.

### Risk — item 2

- For the rare card layout where `columnWidth` is unavailable (e.g. an
  ImagesCard rendered outside `MasonryProvider`), fall back to the existing
  450. Use `useMasonryContext`'s default fallback or an explicit prop.

---

## 3. Make Mantine `useClickOutside` listeners passive

### Diagnosis

The *"Slow scroll regions with many touch event handlers"* warning on the
feed layer is caused by a stack of non-passive `touchstart` listeners on
`document`, all originating from
`@mantine/hooks/esm/use-click-outside/use-click-outside.mjs:18`:

```text
non-passive touchstart #document
  EventTarget.addEventListener @ use-click-outside.mjs:18
  Qj @ react-dom.production.min.js
```

The hook calls `document.addEventListener('touchstart', handler)` without
`{ passive: true }`, which forces Chromium to consult JS before scrolling
on touch devices and triggers the *"main-thread scrolling region"*
promotion on the feed. The handler never `preventDefault`s, so passive
registration is strictly safe.

This bug is unchanged in v8.3.18 and v9.1.1 (verified by reading the
upstream source in each tag), so upgrading does not fix it.

### Where `useClickOutside` is called from

**Direct callers in our codebase (4):**

- [src/components/ActionIconSelect/ActionIconSelect.tsx:28](src/components/ActionIconSelect/ActionIconSelect.tsx#L28)
- [src/components/ActionIconInput.tsx/ActionIconInput.tsx:23](src/components/ActionIconInput.tsx/ActionIconInput.tsx#L23)
- [src/components/Notifications/NotificationsDrawer.tsx:14](src/components/Notifications/NotificationsDrawer.tsx#L14)
- [src/components/Post/EditV2/EditPostTags.tsx:229](src/components/Post/EditV2/EditPostTags.tsx#L229)

These four don't explain the trace's hundreds-of-listeners stack on the
feed page — they're each scoped to specific UI affordances, not per-card.

**Indirect callers — the volume source.**
Inside `@mantine/core`, only two components call `useClickOutside`
directly: `Tree` and **`Popover`**
(`node_modules/@mantine/core/esm/components/Popover/Popover.mjs:144`).
Every other dismissable Mantine component is implemented on top of
`Popover`:

- `Menu`, `MenuSub`
- `HoverCard`
- `Combobox` → `Select`, `Autocomplete`, `MultiSelect`, `TagsInput`,
  `PillsInput`, `NativeSelect` dropdown layer, plus all date-pickers
  (`DateInput`, `MonthPickerInput`, etc.) that use Combobox under the hood

In our feed, the dominant source is the `<Menu>` rendered inside every
[ImageContextMenu](src/components/Image/ContextMenu/ContextMenu.tsx#L14)
on every `ImagesCard`. Popover registers its `useClickOutside` listener
**unconditionally** (no `if (opened)` guard around the hook call), so each
mounted Popover contributes one `mousedown` + one `touchstart` listener on
`document` for as long as the component is in the tree — open or closed.

With ~50–100 cards in the virtualized window, plus header/sidebar Menus
and Tooltips, this is ~100+ document `touchstart` listeners stacking up.
The "Slow scroll regions" warning kicks in around that count and Chrome
flags the entire scroll-area's layer as a slow-scrolling region.

### Patch

Both ESM and CJS builds need the same edit. The actual file paths and
line numbers in the installed v7.17.8:

**`node_modules/@mantine/hooks/esm/use-click-outside/use-click-outside.mjs`**
(line 18):

```diff
-    (events || DEFAULT_EVENTS).forEach((fn) => document.addEventListener(fn, listener));
+    (events || DEFAULT_EVENTS).forEach((fn) =>
+      document.addEventListener(
+        fn,
+        listener,
+        fn.startsWith('touch') ? { passive: true } : undefined
+      )
+    );
     return () => {
-      (events || DEFAULT_EVENTS).forEach((fn) => document.removeEventListener(fn, listener));
+      (events || DEFAULT_EVENTS).forEach((fn) =>
+        document.removeEventListener(
+          fn,
+          listener,
+          fn.startsWith('touch') ? { passive: true } : undefined
+        )
+      );
     };
```

**`node_modules/@mantine/hooks/cjs/use-click-outside/use-click-outside.cjs`**
(line 20) — identical change to the same two `addEventListener` /
`removeEventListener` calls.

We narrow the passive flag to touch events only (`fn.startsWith('touch')`)
so we don't perturb the `mousedown` listener's behavior. Mantine's hook
accepts a custom `events` array, so the flag has to be computed from the
event name rather than hard-coded.

### Recipe

```bash
# 1. Prepare an editable copy
pnpm patch @mantine/hooks
# pnpm prints a temp folder path — note it

# 2. Apply the diff above to both files in that temp folder

# 3. Commit the patch
pnpm patch-commit '<temp-folder-path-from-step-1>'
# Creates patches/@mantine__hooks@7.17.8.patch and adds
# pnpm.patchedDependencies to package.json

# 4. Verify it applies on a clean install
pnpm install
```

This repo has no existing `patches/` folder and no `pnpm.patchedDependencies`
block in `package.json`, so this will be the first patch — the
`patch-commit` step will create both. Both the new `patches/` file and the
`package.json` change need to land in the same commit.

### Validation — item 3

After the patch lands, paste this snippet into the DevTools console on
`/user/<name>/images?sort=Most+Reactions` to detect any remaining
non-passive touch listeners:

```js
['touchstart','touchmove','wheel'].forEach(t => {
  const orig = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function(type, l, opts) {
    if (type === t && opts !== true && (typeof opts !== 'object' || opts.passive !== true))
      console.warn('non-passive', type, this);
    return orig.apply(this, arguments);
  };
});
```

Then:

- [ ] Run the recipe above; commit `patches/@mantine__hooks@7.17.8.patch`
      and the `package.json` change.
- [ ] Reload the page and run the snippet. Confirm the
      `non-passive touchstart #document` line traced to
      `use-click-outside.mjs:18` is gone. Any remaining warnings are from
      a different source — capture them and we'll triage.
- [ ] Open DevTools → Rendering → Layers panel. The *"Slow scroll regions
      with many touch event handlers"* note on `.scroll-area.flex-1`
      should disappear. The layer's compositing reasons should also
      simplify (one less reason listed).
- [ ] File an upstream issue/PR against `mantinedev/mantine` linking to
      `packages/@mantine/hooks/src/use-click-outside/use-click-outside.ts`
      (line 28 in v8.3.18, line 43 in v9.1.1). When it merges, drop our
      patch.

### Risk — item 3

Very low. `useClickOutside` is documented as a click-detection helper and
never calls `preventDefault`. Passive registration cannot change its
detection behavior; it can only let the browser proceed with scrolling
without waiting for the listener. The only failure mode is if a future
Mantine version restructures the hook enough that `pnpm patch` rejects
the diff during install — which would error loudly, not silently break.

### Optional follow-up — `useIdle`

`@mantine/hooks/use-idle` has the same shape of bug (registers `wheel`
and `touchmove` non-passive on `document` without `preventDefault`-ing).
We don't currently import it anywhere in `src/`, and no internal Mantine
component uses it either, so it's not contributing to the trace today. If
we ever start using it, the same patch idiom applies — extend the patch
file rather than ship a second one.

---

## Order of operations

1. Item 1 (`content-visibility: auto`) — biggest impact for least change,
   fully reversible.
2. Item 3 (passive `useClickOutside`) — eliminates the "Slow scroll regions"
   warning class entirely; small patch but touches `node_modules` so worth
   doing as its own commit.
3. Item 2 (right-size images) — incremental memory savings, depends on
   visual sign-off at 2× DPR.

After all three are in, re-record a fresh trace and compare against the
2026-04-28 baseline (Layerize 4716 ms / 13.8 s). Target: Layerize total
under 500 ms over a comparable idle trace.
