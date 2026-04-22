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

- [x] Replace 4 `<Group gap={2}>` wrappers inside the stat Badge with `<div className="flex items-center gap-0.5">` and drop the now-unused `Group` import
- [ ] **Deferred for visual review.** Replace outer `<Badge classNames={{ label: 'flex flex-nowrap gap-2' }}>` stat chip with a styled `<div>` carrying `cardClasses.statChip cardClasses.chip` + explicit flex + padding. Saves 1 DOM node per chip but Mantine Badge's default padding / line-height / text-transform behavior needs a side-by-side visual check before landing.
- [ ] **Deferred for visual review.** Same treatment for the thumbs-up review badge.

### ImagesCard

- [x] Flatten `Box > Stack > Group` pending branch into a single flex-col `<div>`
- [x] Replace `<Group gap={4}>` inside Alert titles with `<div className="flex items-center gap-1">`
- [x] Remove unnecessary `<div className="flex flex-col items-end">` wrappers around Alert body Text
- [ ] **Deferred for visual review.** Evaluate whether the two `<Alert>` blocks (blocked/TOS) can be plain `<div>` with yellow/red styling (Alert renders ~4 wrapper divs; rare states but visually distinctive — replacement needs design check).

### ArticleCard

- [x] Already using `<div className="flex items-center gap-0.5">` pattern inside stat badges — no `Group` wrappers to flatten. Outer Badge → div swap deferred to same visual-review batch as ModelCard.

### CollectionCard

- [x] Replace 2 `<Group gap={2}>` wrappers inside the stat Badge with `<div className="flex items-center gap-0.5">`
- [x] Flatten the `CollectionCardHeader` layout Groups (`<Group gap={4} justify="space-between" wrap="nowrap">` + inner `<Group gap="xs">`) into plain flex `<div>`s; drop the now-unused `Group` import

### BountyCard

- [ ] **Deferred for visual review.** [BountyCard.tsx:159-223](../src/components/Cards/BountyCard.tsx#L159-L223) — The outer Badge wraps a flex row of four `<IconBadge>` stat counters. The nested IconBadge components each render their own outer wrapper, which is the real restructure target, but it's not a shallow swap — each IconBadge has icon color, icon-spacing, and font-weight behaviors that need to be reproduced precisely.
- [ ] **Keeping as HoverCard.** [BountyCard.tsx:127-144](../src/components/Cards/BountyCard.tsx#L127-L144) — Re-examined: the "pending scan" popup is not a simple label; it's a title + description with different weights. Tooltip is the wrong tool here. Leaving HoverCard in place.

### ImagesAsPostsCard

Rendered on every model's gallery page ("Images as posts" view). Two branches for single-image vs multi-image (carousel), with heavily duplicated structure.

Safe flattens (zero visual risk):

- [ ] [L263](../src/components/Image/AsPosts/ImagesAsPostsCard.tsx#L263) and [L346](../src/components/Image/AsPosts/ImagesAsPostsCard.tsx#L346) — Replace `<Stack gap="xs" className="absolute right-2 top-2 z-10">` (hover-action column, duplicated in both branches) with `<div className="absolute right-2 top-2 z-10 flex flex-col gap-2">`
- [ ] [L164](../src/components/Image/AsPosts/ImagesAsPostsCard.tsx#L164) — Flatten `<Group gap="xs" wrap="nowrap">` wrapping the timestamp + resource-attribution icons in `UserAvatar` subText
- [ ] [L171](../src/components/Image/AsPosts/ImagesAsPostsCard.tsx#L171) — Flatten inner `<Group ml={6} gap={4}>` around the auto/manual resource Tooltips
- [ ] [L227](../src/components/Image/AsPosts/ImagesAsPostsCard.tsx#L227) — Flatten `<Group gap={4} wrap="nowrap">` inside the review Badge (thumbs icon + optional message icon)

Structural (needs review):

- [ ] **Duplicated render block** — the ~75-line block at [L256-333](../src/components/Image/AsPosts/ImagesAsPostsCard.tsx#L256-L333) (single-image) and [L338-423](../src/components/Image/AsPosts/ImagesAsPostsCard.tsx#L338-L423) (carousel slide) is almost verbatim copy-paste: `ImageGuard2` render prop → `OnsiteIndicator` + `BlurToggle` + hover-action column + `RoutedDialogLink` + `EdgeMedia2` + `Reactions` + `ImageMetaPopover2`. Extracting a shared `<ImagesAsPostsCardImage>` component wouldn't reduce DOM per card but would halve the maintenance surface and ensure future optimizations apply to both branches.
- [ ] [L153-160](../src/components/Image/AsPosts/ImagesAsPostsCard.tsx#L153-L160) — `<Paper p="xs" radius={0}>` header container. Paper adds wrapper divs + theme-reactive background. Replaceable with a plain `<div>` + Tailwind `bg-white dark:bg-dark-7` (or matching token). Low per-card DOM impact but this renders on every card of the gallery page. Needs a theme-color visual check.

### What to skip on ImagesAsPostsCard

- `<HoverCard>` on `PinnedIndicator` ([L113-136](../src/components/Image/AsPosts/ImagesAsPostsCard.tsx#L113-L136)) — popup content has a title + description with different weights. Tooltip is the wrong tool.
- `<Badge size="xs" color="violet">OP</Badge>` ([L195](../src/components/Image/AsPosts/ImagesAsPostsCard.tsx#L195)) — single-text badge passed through `UserAvatar`. Negligible.
- `<LegacyActionIcon>` wrappers — already minimal.

---

## Phase 2 — Medium impact, low risk

### PostsCard

- [x] [PostsCard.tsx:59-61](../src/components/Post/Infinite/PostsCard.tsx#L59-L61) — Replaced `<AspectRatio ratio={...}>` with `<div style={{ aspectRatio: w / h }}>` and dropped the `AspectRatio` import.

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

## Beyond DOM Count — Browser Cost Audit (ImagesAsPostsCard)

Same scaling framing as ImagesCard, but this card also has a carousel branch that amplifies some costs.

### ImagesAsPostsCard — High impact

- [ ] **Eager dialog state in the carousel branch** ([L362-365](../src/components/Image/AsPosts/ImagesAsPostsCard.tsx#L362-L365)) — `state={{ imageId: image.id, images: data.images }}` references the full post's image array and is rebuilt per render × per slide. Same fix pattern we shipped in ImagesCard: use the `getState` prop on `RoutedDialogLink` so the state is built on click. Single-image branch at [L279-282](../src/components/Image/AsPosts/ImagesAsPostsCard.tsx#L279-L282) already passes `[image]` (cheap) — fine as is.

- [ ] **`handleRemixClick` useCallback is dead code** ([L243-254](../src/components/Image/AsPosts/ImagesAsPostsCard.tsx#L243-L254)):

  ```tsx
  const handleRemixClick = useCallback(
    (selectedImage: typeof image) => (e: React.MouseEvent) => { ... },
    []
  );
  ```

  The outer function is stable, but `handleRemixClick(image)` returns a **fresh** inner closure every render. The `onClick` prop on `HoverActionButton` is always a new reference, defeating any internal memoization. Either drop the `useCallback` (since it provides no stability benefit as written) or restructure so the handler stabilizes per-image-id.

- [ ] **Carousel slide mounting** — `SimpleImageCarousel` renders slides inside its `.Container`. Worth verifying whether off-screen slides mount eagerly. If so, a post with 20 images mounts 20 × (EdgeMedia + Reactions + ImageContextMenu + meta popover trigger) per card, and the multi-video GPU-memory concern compounds for video posts.

### ImagesAsPostsCard — Medium impact

- [ ] **`cosmeticData` object rebuilt every render** ([L73-84](../src/components/Image/AsPosts/ImagesAsPostsCard.tsx#L73-L84)) — spread + conditional merge every render. Wrap in `useMemo` with deps `[cosmetic?.data, pinned, theme.colors.orange, colorScheme]`. Minor allocation per card but breaks child memoization on `TwCosmeticWrapper`.

- [ ] **`data.images.find((i) => isDefined(i.cosmetic))?.cosmetic` called twice** — once at [L72](../src/components/Image/AsPosts/ImagesAsPostsCard.tsx#L72) in the top-level and again at [L150](../src/components/Image/AsPosts/ImagesAsPostsCard.tsx#L150) inside the header. Hoist to a single compute at the top and pass down.

- [ ] **Two separate `.some()` passes over `data.images`** at [L143-147](../src/components/Image/AsPosts/ImagesAsPostsCard.tsx#L143-L147) for `fromAutoResource` / `fromManualResource`. Combine into a single loop that returns both flags.

### ImagesAsPostsCard — Low impact

- [ ] **Inline `wrapperProps={{ style: { zIndex: 1 } }}` on `EdgeMedia2`** ([L296](../src/components/Image/AsPosts/ImagesAsPostsCard.tsx#L296), [L381](../src/components/Image/AsPosts/ImagesAsPostsCard.tsx#L381)) — hoist to module-scoped constant. Contained by the card's outer memo, but breaks memoization if `EdgeMedia2` has internal `React.memo`.

---

## Drop-shadow usage across other card components

Audit of `filter: drop-shadow` / `filter="drop-shadow(...)"` usage in other feed card components. Same "feed scale" framing as item #2 above applies: worth changing because these components render dozens to hundreds of times per page, each adding a filter layer.

### High priority — shared context-menu icon (affects 4 card types with one edit)

- [x] [ActionIconDotsVertical.tsx:12-17](../src/components/Cards/components/ActionIconDotsVertical.tsx#L12-L17) — collapsed the stacked double drop-shadow into a **single CSS drop-shadow applied via `style={{ filter: ... }}`** (not the SVG `filter` attribute). Preserves the "floating dots" visual the team wants over varying image backgrounds; halves the filter passes and fixes the incorrect-syntax issue.

  Why not the wrapper-circle pattern we used in ImagesCard: on the three-dots icon, a dark pill/circle visually reads as a button and changes the card chrome in a way the design didn't want. The info icon (round, single glyph) tolerates the wrapper; the dots icon does not.

Affected call-sites (all benefit from the single edit):

- [ModelCardContextMenu.tsx](../src/components/Cards/ModelCardContextMenu.tsx) (every ModelCard)
- [ComicCardContextMenu.tsx](../src/components/Cards/ComicCardContextMenu.tsx) (every ComicCard)
- [BountyContextMenu.tsx](../src/components/Bounty/BountyContextMenu.tsx) (every BountyCard)
- [Image/ContextMenu/ContextMenu.tsx](../src/components/Image/ContextMenu/ContextMenu.tsx) (every non-blocked ImagesCard)

### Medium priority — same pattern, duplicated

- [x] [ImagesAsPostsCard.tsx:322-336](../src/components/Image/AsPosts/ImagesAsPostsCard.tsx#L322-L336) and [L411-L425](../src/components/Image/AsPosts/ImagesAsPostsCard.tsx#L411-L425) — replaced two `<IconInfoCircle>` instances using the stacked drop-shadow with the same background-circle wrapper we used in ImagesCard. Dropped the now-redundant `<LegacyActionIcon component="div">` wrapper at the same time.

### Low priority — shared CSS class for card titles

- [x] [Cards.module.css:207-210](../src/components/Cards/Cards.module.css#L207-L210) — `.dropShadow` rule now uses `text-shadow: 1px 1px 1px rgba(0, 0, 0, 0.8)` instead of `filter: drop-shadow(...)`. Applied class is used on card title `<Text>` in ArticleCard, CollectionCard, ComicCard, ModelCard, PostCard. `text-shadow` is a text rendering effect (not a filter pipeline op), so it doesn't promote the element to its own compositing layer. Visual diff is negligible for a 1px blur.

### Minor — Tailwind utility on one card

- [x] [ChallengeCard.tsx:158-166](../src/components/Cards/ChallengeCard.tsx#L158-L166) — replaced `className="drop-shadow-sm"` on the theme label with `style={{ textShadow: '0 1px 1px rgb(0 0 0 / 0.05)' }}`. Preserves the same subtle shadow alpha.

### What to leave alone

- `Cards.module.css:228` — `filter: blur(8px)` on `.winnerFirst/Second/Third::before` for the animated glow behind winner cards. Only renders on winner cards (tiny count), the blur is the whole point of the effect, and it's on a pseudo-element behind the card so compositing layer promotion is intentional.
- `CosmeticLights.module.scss:32` — `filter: blur(3px)` for cosmetic glow. Same reasoning: the blur is the effect; rare per-page usage.
