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

### ModelCard — done

- [x] Flatten 4 `<Group gap={2}>` wrappers inside the stat Badge; drop unused `Group` import
- [x] Extract `ModFlagBadge` helper; consolidate POI/Minor/NSFW into a single pipe-separated badge
- [x] `useMemo` the `statusBadgeStyle` object
- [x] Remove dead code (`image`, `aspectRatio`, `abbreviateNumber`)
- [x] Wrap in `React.memo`
- [x] Replace per-card `trpc.user.getEngagedModels` + `.includes()` with shared `useReviewedModelIds` hook (WeakMap-cached Set)
- [x] Memoize `baseMetrics` and `href`
- [x] Memoize `ModelCardContextProvider` value (makes the `memo` effective)

### ImagesCard — done

- [x] Flatten `Box > Stack > Group` pending branch into a single flex-col `<div>`
- [x] Replace `<Group gap={4}>` inside Alert titles with `<div className="flex items-center gap-1">`
- [x] Remove unnecessary `<div className="flex flex-col items-end">` wrappers around Alert body Text
- [x] Defer dialog state via `getState` on `RoutedDialogLink`
- [x] Replace stacked SVG drop-shadows on meta icon with `bg-black/50 rounded-full` wrapper

### ArticleCard — done

- [x] Already using `<div className="flex items-center gap-0.5">` pattern inside stat badges; no `Group` wrappers to flatten

### CollectionCard — done

- [x] Replace 2 `<Group gap={2}>` wrappers inside the stat Badge with `<div className="flex items-center gap-0.5">`
- [x] Flatten the `CollectionCardHeader` layout Groups into plain flex `<div>`s; drop unused `Group` import

### BountyCard — done

- [x] Added `useBountyEngagementSets()` in `bounty.utils.ts` — returns `{ favoriteIds, trackedIds }` as WeakMap-cached Sets. Swapped `engagements?.Favorite?.find()` / `engagements?.Track?.find()` for `favoriteIds.has(id)` / `trackedIds.has(id)`. Same pattern as `useReviewedModelIds`.
- [x] **Keeping as HoverCard.** [BountyCard.tsx:127-144](../src/components/Cards/BountyCard.tsx#L127-L144) — the "pending scan" popup is a title + description with different weights. Tooltip is the wrong tool.

### ImagesAsPostsCard — Phase 1 done (Steps 6–7 open)

Phase 1 items are tracked in detail in the execution plan below. Summary of state:

- [x] Context-value instability fix at `ImagesAsPostsInfiniteProvider` + caller
- [x] Stack × 2 and Group × 3 flattened
- [x] `handleRemixClick` dead `useCallback` removed
- [x] Carousel dialog state deferred via `getState`
- [x] `cosmetic` lookup hoisted + memoized; `cosmeticData` memoized
- [x] Combined the two `.some()` passes
- [x] `wrapperProps` style hoisted to module scope
- [ ] **Step 6 — structural** (user-direction: "circle back later")
- [ ] **Step 7 — validation** (manual: screenshot diff + React Profiler scroll test)

### What to skip on ImagesAsPostsCard

- `<HoverCard>` on `PinnedIndicator` ([L113-136](../src/components/Image/AsPosts/ImagesAsPostsCard.tsx#L113-L136)) — popup content has a title + description with different weights. Tooltip is the wrong tool.
- `<Badge size="xs" color="violet">OP</Badge>` ([L195](../src/components/Image/AsPosts/ImagesAsPostsCard.tsx#L195)) — single-text badge passed through `UserAvatar`. Negligible.
- `<LegacyActionIcon>` wrappers — already minimal.

---

## ImagesAsPostsCard — Execution Plan

Ordered sequence of work. Follows the same progression that worked for ModelCard: fix render effectiveness first, then safe flattens, then browser-cost wins, then memoization, then structural changes.

The card is already wrapped in `memo(ImagesAsPostsCardNoMemo)` at [L111](../src/components/Image/AsPosts/ImagesAsPostsCard.tsx#L111), so most wins come from making the memo *actually effective* and reducing per-render work inside.

### Step 1 — Fix context-value instability (highest payoff)

- [x] [ImagesAsPostsInfinite.tsx](../src/components/Image/AsPosts/ImagesAsPostsInfinite.tsx) — memoized the `filters` object (was rebuilt via `removeEmpty({...})` every render) and wrapped the provider value in `useMemo` at the call site. Context consumers now only re-render when one of `{filters, modelVersions, showModerationOptions, model}` actually changes.

  **Fix:** `useMemo` the value at the Provider (or at the caller). Same pattern we applied to `ModelCardContextProvider`.

  ```tsx
  // ImagesAsPostsInfiniteProvider.tsx
  export function ImagesAsPostsInfiniteProvider({
    children,
    filters,
    modelVersions,
    showModerationOptions,
    model,
  }: { children: React.ReactNode } & ImagesAsPostsInfiniteState) {
    const value = useMemo(
      () => ({ filters, modelVersions, showModerationOptions, model }),
      [filters, modelVersions, showModerationOptions, model]
    );
    return (
      <ImagesAsPostsInfiniteContext.Provider value={value}>
        {children}
      </ImagesAsPostsInfiniteContext.Provider>
    );
  }
  ```

  Caller at [ImagesAsPostsInfinite.tsx:158](../src/components/Image/AsPosts/ImagesAsPostsInfinite.tsx#L158) switches to spread props rather than pass a `value` object.

  Nested refs inside `value` (`filters`, `modelVersions`, `model`) must themselves be stable. If any are rebuilt per render upstream, they need their own memoization first — verify before landing.

### Step 2 — Safe DOM flattens (zero visual risk)

- [x] Both `<Stack gap="xs">` hover-action columns → `<div className="... flex flex-col gap-2">`
- [x] `<Group gap="xs" wrap="nowrap">` UserAvatar subText row → `<div className="flex flex-nowrap items-center gap-2.5">`
- [x] `<Group ml={6} gap={4}>` resource-attribution row → `<div className="ml-1.5 flex items-center gap-1">`
- [x] `<Group gap={4} wrap="nowrap">` review-badge inner → `<div className="flex flex-nowrap items-center gap-1">`
- [x] Dropped unused `Group` / `Stack` imports

### Step 3 — Browser-cost wins

- [x] **Dead `useCallback` removed** — the curry's inner closure was recreated per invocation anyway, so the `useCallback` provided no stability. Swapped to a plain arrow and dropped the import. Preserved signature since it's called per-image inline.

- [x] **Carousel dialog state deferred** via `getState={() => ({ imageId, images: data.images })}`. Href still resolves from the cheap `state={{ imageId }}`; the full images-array reference only materializes on click.

  ```tsx
  <RoutedDialogLink
    name="imageDetail"
    state={{ imageId: image.id }}
    getState={() => ({ imageId: image.id, images: data.images })}
    className={classes.link}
  >
  ```

  For a post with 20 images × however many posts on screen, this avoids rebuilding a 20-image reference per render.

  Single-image branch at [L279-282](../src/components/Image/AsPosts/ImagesAsPostsCard.tsx#L279-L282) is already cheap (`images: [image]`); leave it.

### Step 4 — Memoize per-render allocations

- [x] `cosmeticData` wrapped in `useMemo` with deps `[cosmetic?.data, pinned, theme, colorScheme]`.
- [x] Hoisted the cosmetic lookup to `useMemo` in `ImagesAsPostsCardNoMemo` and pass `cosmetic` as a prop to `ImagesAsPostsCardHeader` — removes the duplicate `find` pass.
- [x] Combined the two `.some()` passes into a single `for...of` loop with early-break once both flags are set.

### Step 5 — Inline-object hoisting

- [x] `wrapperProps` on `EdgeMedia2` — hoisted to module-scoped `edgeMediaWrapperProps` constant. Both usages (single-image + carousel-slide) now share the reference.

### Step 6 — Structural consolidation (needs review)

- [ ] Extract `<ImagesAsPostsCardImage>` component from the ~75-line block duplicated between [L256-333](../src/components/Image/AsPosts/ImagesAsPostsCard.tsx#L256-L333) (single-image) and [L338-423](../src/components/Image/AsPosts/ImagesAsPostsCard.tsx#L338-L423) (carousel slide). Halves the surface area and ensures future optimizations apply to both branches automatically.

  Propose signature:

  ```tsx
  function ImagesAsPostsCardImage({
    image,
    images,      // slice for dialog navigation (varies by branch)
    connectType, // undefined for single, 'post' for carousel
    connectId,
    onRemixClick,
  }: { ... }) { ... }
  ```

- [ ] [L153-160](../src/components/Image/AsPosts/ImagesAsPostsCard.tsx#L153-L160) — `<Paper p="xs" radius={0}>` header container → plain `<div>` with Tailwind `bg-white dark:bg-dark-7` (or matching token). Needs theme-color visual check before landing.

### Step 7 — Validation

- [ ] Typecheck + lint + prettier clean
- [ ] Screenshot diff the "Images as posts" gallery page in light + dark mode
- [ ] React Profiler scroll test: confirm cards skip re-render on unrelated parent updates after Step 1 lands
- [ ] Functional check: click single-image → dialog opens; click carousel slide → dialog opens with prev/next nav intact; remix button still opens generator

### Expected impact

- Step 1 is the single biggest win — makes the existing `memo` effective
- Steps 2 + 5 are ~zero-risk cleanup
- Steps 3 + 4 eliminate per-render allocations that compound at feed scale
- Step 6 is a maintainability win that sets up future DOM-reduction sweeps to apply to both render branches at once

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
