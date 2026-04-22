# Feed Card DOM Audit — Reduction Checklist

Goal: reduce DOM node count on infinite-scroll feed pages by removing unnecessary Mantine wrappers. Feeds render 100–500+ cards per page, so every saved node per card compounds.

## Baseline (approximate nodes per card)

- [ImagesCard.tsx](../src/components/Image/Infinite/ImagesCard.tsx) — ~100–120
- [BountyCard.tsx](../src/components/Cards/BountyCard.tsx) — ~105
- [ModelCard.tsx](../src/components/Cards/ModelCard.tsx) — ~95
- [ArticleCard.tsx](../src/components/Cards/ArticleCard.tsx) — ~85
- [CollectionCard.tsx](../src/components/Cards/CollectionCard.tsx) — ~80
- [PostsCard.tsx](../src/components/Post/Infinite/PostsCard.tsx) — ~65 (already lean)

Target: ~15–20% reduction on a 200-card Models page (~3,000 nodes).

## Guiding principles

- **Replace layout-only Mantine wrappers** (`Group`, `Stack`, `Box`, `Center`) with `<div className="flex ...">` when they exist only for flex/spacing.
- **Leave `<Text>` alone.** Text carries theme-bound styling (font-size tokens, line-height, font-family) that `<span>` doesn't replicate. Node count is the same anyway, so there's no real win.
- **Replace `<Badge>` with a styled `<div>`** when `classNames={{ label: 'flex ...' }}` is already being used — the Badge root becomes dead weight.
- **Keep Mantine** for: `lineClamp`, portal/interaction logic (Tooltip, Popover, Modal), theme-reactive color (`c="success.5"`), `<ActionIcon>` (already single element).
- **Zero behavior/visual change** — this is pure DOM reduction. Test before and after.

---

## Phase 1 — High impact, zero risk

### ModelCard

- [ ] [ModelCard.tsx:234-265](../src/components/Cards/ModelCard.tsx#L234-L265) — Replace 4 `<Group gap={2}>` wrappers with `<div className="flex items-center gap-0.5">`
- [ ] [ModelCard.tsx:228-266](../src/components/Cards/ModelCard.tsx#L228-L266) — Replace outer `<Badge classNames={{ label: 'flex flex-nowrap gap-2' }} variant="light" radius="xl">` stat chip with `<div className="rounded-full px-3 py-1 flex flex-nowrap gap-2 ..." >` (carry `cardClasses.statChip cardClasses.chip`)
- [ ] [ModelCard.tsx:269-285](../src/components/Cards/ModelCard.tsx#L269-L285) — Same treatment for the thumbs-up review badge

### ImagesCard

- [x] Flatten `Box > Stack > Group` pending branch into a single flex-col `<div>`
- [x] Replace `<Group gap={4}>` inside Alert titles with `<div className="flex items-center gap-1">`
- [x] Remove unnecessary `<div className="flex flex-col items-end">` wrappers around Alert body Text
- [ ] Evaluate whether the two `<Alert>` blocks (blocked/TOS) can be plain `<div>` with yellow/red styling (Alert renders ~4 wrapper divs; rare states but heavy when shown)

### ArticleCard

- [ ] [ArticleCard.tsx:100-140](../src/components/Cards/ArticleCard.tsx#L100-L140) — Flatten `<Group>` wrappers inside stat badges; same `Badge` → styled `<div>` treatment as ModelCard

### CollectionCard

- [ ] [CollectionCard.tsx:100-120](../src/components/Cards/CollectionCard.tsx#L100-L120) — Same `Group` + `Badge` flattening as above

### BountyCard

- [ ] [BountyCard.tsx:159-223](../src/components/Cards/BountyCard.tsx#L159-L223) — Replace outer `<Badge>` + nested `<IconBadge>` stat row with a single `<div className="rounded-full px-2 py-1 flex items-center gap-2 text-xs" style={{backgroundColor: 'rgba(0,0,0,0.31)'}}>` containing inline `<div className="flex items-center gap-1">` groups
- [ ] [BountyCard.tsx:127-144](../src/components/Cards/BountyCard.tsx#L127-L144) — Consider `<Tooltip>` in place of `<HoverCard>` for the pending-scan alert (lighter trigger; same UX for a simple label)

---

## Phase 2 — Medium impact, low risk

### PostsCard

- [ ] [PostsCard.tsx:59-61](../src/components/Post/Infinite/PostsCard.tsx#L59-L61) — Replace `<AspectRatio ratio={...}>` with `<div style={{ aspectRatio: w / h }}>` (CSS `aspect-ratio` is universally supported)

## Phase 3 — Validate first

- [ ] Measure actual DOM count on a 200-card `/models` page before and after Phase 1 via `document.querySelectorAll('*').length`
- [ ] Profile scroll jank on a low-end device (Chrome DevTools → Performance → 4x CPU throttle) before and after
- [ ] Screenshot diff each card type in light + dark mode after each phase

---

## What to skip

- `<ActionIcon>` → `<button>`: Mantine's `ActionIcon` is already a single `<button>` with one wrapper — savings <1 node
- `<UnstyledButton>` → `<button>`: already minimal
- `TwCard` / `CosmeticCard` / `TwCosmeticWrapper`: already conditional (early return when no cosmetic) and load-bearing for the cosmetic system
- Card-level refactors that change which component renders which: out of scope

---

## Success criteria

- [ ] Models feed (200 cards): DOM count reduced by ≥15%
- [ ] Images feed (200 cards): DOM count reduced by ≥15%
- [ ] Zero visual regressions in light and dark mode
- [ ] Zero behavior regressions (hover, click, cosmetic rendering, badges, counts)
- [ ] TypeScript + lint + prettier clean

---

## Beyond DOM Count — Browser Cost Audit (ImagesCard)

DOM reduction is one lever; the following are non-DOM patterns in [ImagesCard.tsx](../src/components/Image/Infinite/ImagesCard.tsx) that cost real CPU/paint per card × page size. Ordered by expected impact.

## High impact

### 1. Eager dialog state materialization on every render

**Location:** [ImagesCard.tsx:114-121](../src/components/Image/Infinite/ImagesCard.tsx#L114-L121)

```tsx
<RoutedDialogLink
  name="imageDetail"
  state={{
    imageId: image.id,
    images: getDialogState(image.id, getImages()),  // builds a 100-item slice
    ...contextProps,
  }}
  className="absolute inset-0"
>
```

On every card render, `getDialogState` runs `findIndex` + `slice(±50)` against the full feed. For a 200-card page that's **20,000 image refs allocated per feed render** — before any click happens.

**Why it's solvable:** The `imageDetail` dialog resolver ([image-detail.dialog.ts:11-15](../src/components/Dialog/routed-dialog/image-detail.dialog.ts#L11-L15)) only uses `imageId` for the URL. The `images` array is pure session state — it's never serialized into the href and only matters at click time.

**Suggested fix — defer to click:**

Option A (smallest change to `RoutedDialogLink`): add an optional `getState` prop that takes precedence over `state` at click time.

```tsx
// in RoutedDialogLink
{
  name,
  state,
  getState,  // NEW: () => state
  ...
}

const handleClick = (e) => {
  if (!e.ctrlKey) {
    e.preventDefault();
    triggerRoutedDialog({ name, state: getState ? getState() : state });
    onClick?.();
  }
};
```

Then in `ImagesCard`:

```tsx
<RoutedDialogLink
  name="imageDetail"
  state={{ imageId: image.id, ...contextProps }}
  getState={() => ({
    imageId: image.id,
    images: getDialogState(image.id, getImages()),
    ...contextProps,
  })}
  className="absolute inset-0"
>
```

This keeps the href computation cheap (resolver only reads `imageId`) and builds the 100-item slice exactly once, on click, for the card the user actually opened. Savings: ~20,000 allocations → 0 on initial feed render.

Option B (no component changes): replace `RoutedDialogLink` with `<a>` + manual `onClick` that calls `triggerRoutedDialog` with the freshly-built state, and set `href={`/images/${image.id}`}` for right-click-copy support. Similar effect, more code per call-site.

Also move `getDialogState` out of the component body ([L97-102](../src/components/Image/Infinite/ImagesCard.tsx#L97-L102)) — it closes over nothing, so there's no reason to re-create the function per render.

---

### 2. Stacked SVG drop-shadows on the meta icon

**Location:** [ImagesCard.tsx:226-243](../src/components/Image/Infinite/ImagesCard.tsx#L226-L243)

```tsx
<IconInfoCircle
  color="white"
  filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
  opacity={0.8}
  strokeWidth={2.5}
  size={26}
  className="m-0.5"
/>
```

Why this is worth changing at feed scale:

- `filter: drop-shadow()` is a real filter-pipeline effect (rasterize → blur → composite), not a free paint trick.
- Two stacked drop-shadows = two filter passes.
- Filter elements are typically promoted to their own GPU compositing layer. At 200+ cards each with a filtered icon, that's 200+ extra layers consuming GPU memory — relevant here because the codebase already has known scroll-area GPU-memory issues.
- The `filter` attribute on an SVG element expects `url(#filterId)`, not CSS function syntax — so on top of everything else, this particular usage may not even be rendering as intended.

Note: browsers cache compositing layers aggressively, so this is **not** a per-scroll-frame cost. The concern is GPU memory footprint and layer-management overhead at scale, not per-frame paint.

**Applied fix — background circle:**

```tsx
<ImageMetaPopover2 imageId={data.id} type={data.type}>
  <div className="m-0.5 flex size-7 items-center justify-center rounded-full bg-black/50">
    <IconInfoCircle color="white" opacity={0.9} strokeWidth={2.5} size={20} />
  </div>
</ImageMetaPopover2>
```

A solid semi-transparent circle behind the white icon achieves the same readability goal with a flat rectangular paint — no filter, no extra compositing layer. Adds 1 wrapper node per card with meta but removes the filter layer.

**Rule of thumb for applying this elsewhere:** don't chase `drop-shadow` on components that only render a handful of times. This is a **feed/grid scale** optimization. The threshold where it's worth doing is roughly 100+ instances on screen.

---

## Medium impact

### 3. `.footer` box-shadow stacked on a gradient

**Location:** [ImagesCard.module.scss:10-13](../src/components/Image/Infinite/ImagesCard.module.scss#L10-L13)

```scss
background: linear-gradient(0deg, rgba(37, 38, 43, 0.8), rgba(37, 38, 43, 0));
box-shadow: 0 -2px 6px 1px rgba(0, 0, 0, 0.16);
```

Every visible card's footer re-composites both the gradient and the box-shadow on scroll. Fold the shadow into the gradient by extending the dark stop further and drop the `box-shadow` line.

### 4. `new Date(image.publishedAt) > new Date()` on every render

**Location:** [ImagesCard.tsx:65](../src/components/Image/Infinite/ImagesCard.tsx#L65)

Two `Date` allocations per card per render, but `scheduled` / `notPublished` are only rendered inside the moderator/author UI column ([L184-197](../src/components/Image/Infinite/ImagesCard.tsx#L184-L197)). Gate the compute behind `isModerator` (or the post-owner check) so non-mods skip it entirely.

### 5. Inline object props break child memoization

- `state={{...}}` on RoutedDialogLink ([L115-120](../src/components/Image/Infinite/ImagesCard.tsx#L115-L120)) — will be addressed by fix #1.
- `wrapperProps={{ className: 'flex-1 h-full' }}` on EdgeMedia2 ([L133](../src/components/Image/Infinite/ImagesCard.tsx#L133)) — hoist to a module-scoped constant.
- `style={{ pointerEvents: 'auto' }}` on BlurToggle ([L147](../src/components/Image/Infinite/ImagesCard.tsx#L147)) — hoist to a module-scoped constant.

None of these affect the memoized card itself, but they defeat any `React.memo` inside the child components.

### 6. `<Tooltip>` for one-word labels on rare mod icons

**Location:** [ImagesCard.tsx:184-197](../src/components/Image/Infinite/ImagesCard.tsx#L184-L197)

Each `<Tooltip>` creates a Floating-UI instance and attaches hover listeners on mount. For a static label like "Scheduled" / "Not published", a native `title=` attribute on the icon button is free. Only relevant when those icons render (mod view), but saves 2 Floating-UI instances per such card.

---

## Worth verifying (can't be determined from this file alone)

- **`MetricSubscriptionProvider` per card** ([L36-38](../src/components/Image/Infinite/ImagesCard.tsx#L36-L38)) — 200 subscriptions per page. Confirm this multiplexes over a shared socket.
- **`EdgeMedia2` with video type** — 200 autoplaying videos in a feed is a known GPU-memory hazard. Confirm viewport-gated playback.
- **`ImageContextMenu` / `HoverActionButton`** — confirm their handlers attach on hover/mount-of-trigger, not eagerly at card mount (400+ listeners per page if eager).

---

## Drop-shadow usage across other card components

Audit of `filter: drop-shadow` / `filter="drop-shadow(...)"` usage in other feed card components. Same "feed scale" framing as item #2 above applies: worth changing because these components render dozens to hundreds of times per page, each adding a filter layer.

### High priority — shared context-menu icon (affects 4 card types with one edit)

- [ ] [ActionIconDotsVertical.tsx:15](../src/components/Cards/components/ActionIconDotsVertical.tsx#L15) — identical stacked double drop-shadow pattern on `<IconDotsVertical>`. Used by:
  - [ModelCardContextMenu.tsx](../src/components/Cards/ModelCardContextMenu.tsx) (every ModelCard)
  - [ComicCardContextMenu.tsx](../src/components/Cards/ComicCardContextMenu.tsx) (every ComicCard)
  - [BountyContextMenu.tsx](../src/components/Bounty/BountyContextMenu.tsx) (every BountyCard)
  - [Image/ContextMenu/ContextMenu.tsx](../src/components/Image/ContextMenu/ContextMenu.tsx) (every non-blocked ImagesCard)

One edit here fixes the three-dots icon across every card feed in the app. Apply the same background-circle wrapper pattern we used in ImagesCard.

### Medium priority — same pattern, duplicated

- [ ] [ImagesAsPostsCard.tsx:328](../src/components/Image/AsPosts/ImagesAsPostsCard.tsx#L328) and [L417](../src/components/Image/AsPosts/ImagesAsPostsCard.tsx#L417) — two separate instances of the exact same stacked drop-shadow on `<IconInfoCircle>` that we just fixed in ImagesCard. Apply the same fix.

### Low priority — shared CSS class for card titles

- [ ] [Cards.module.css:209-211](../src/components/Cards/Cards.module.css#L209-L211) — `.dropShadow` applies `filter: drop-shadow(1px 1px 1px rgba(0, 0, 0, 0.8))` to card title `<Text>` in ArticleCard, CollectionCard, ComicCard, ModelCard, PostCard.

Single shadow, small 1px blur — much cheaper than the stacked-two-shadows case above. But for a text element, `text-shadow` is strictly cheaper than `filter: drop-shadow` (text-shadow is a text rendering effect, not a filter pipeline op, and doesn't promote the element to its own compositing layer). Swap:

```css
.dropShadow {
  /* filter: drop-shadow(1px 1px 1px rgba(0, 0, 0, 0.8)); */
  text-shadow: 1px 1px 1px rgba(0, 0, 0, 0.8);
}
```

Visual difference is negligible for a 1px blur. Low risk, moderate scale (one edit touches 5 card types' titles).

### Minor — Tailwind utility on one card

- [ ] [ChallengeCard.tsx:159](../src/components/Cards/ChallengeCard.tsx#L159) — `className="drop-shadow-sm"` on a title `<Text>`. Same reasoning as the CSS class above; replace with a `text-shadow` utility or inline style if we want full consistency. Not urgent.

### What to leave alone

- `Cards.module.css:228` — `filter: blur(8px)` on `.winnerFirst/Second/Third::before` for the animated glow behind winner cards. Only renders on winner cards (tiny count), the blur is the whole point of the effect, and it's on a pseudo-element behind the card so compositing layer promotion is intentional.
- `CosmeticLights.module.scss:32` — `filter: blur(3px)` for cosmetic glow. Same reasoning: the blur is the effect; rare per-page usage.
