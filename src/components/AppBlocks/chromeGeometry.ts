/**
 * Responsive geometry for the App Blocks host chrome (`AppBlockChrome`, exported
 * from `src/components/AppBlocks/IframeHost.tsx`).
 *
 * WHY A SEPARATE PURE MODULE. The chrome is the one piece of App Blocks UI that
 * renders on two surfaces with wildly different widths — the narrow
 * `model.sidebar_top` slot and the full-page `/apps/run/<slug>` frame — and it
 * used to carry hard-coded pixel caps for both. Putting the decision in a pure
 * function keeps it testable in the node `unit` project, which is the tier that
 * EXECUTES such an assertion (the Vitest browser-mode `component` project runs in
 * CI as the REPORT-ONLY `preview / component-tests` status; the node tier is
 * report-only on a pull request too and renders a real verdict on a push to
 * `main` — neither blocks a merge, since `main` requires no status check at all
 * in this repo), exactly as `slotReservation.ts` and `selectChromeRecentApps`
 * already do.
 *
 * 🔴 ONE BREAKPOINT SCALE, AND IT IS THE PX SCALE. This repo has two scales that
 * agree on exactly one key:
 *   - the px scale — `src/utils/breakpoints.json`, mirrored by Tailwind and by
 *     `mantineContainerSizes` in `src/utils/mantine-css-helpers.ts`:
 *     xs 480 · sm 768 · md 1024 · lg 1184 · xl 1440
 *   - Mantine's own stock em scale, which this repo never overrode and which
 *     every Mantine responsive prop (`visibleFrom`, `hiddenFrom`, the `Grid`
 *     breakpoints) uses: 576 · 768 · 992 · 1200 · 1408
 * Only `sm` (768) is the same in both. This module adopts the PX scale and
 * imports it from `breakpoints.json` rather than restating it, so there is
 * nothing to drift. Nothing in the chrome may use a Mantine responsive prop —
 * mixing the two inside one component means two different numbers wearing the
 * same name.
 *
 * 🔴 THE MEASURED BOX IS THE CHROME'S OWN ELEMENT, NOT THE VIEWPORT AND NOT THE
 * `main` CONTAINER. A `ContainerProvider` ancestor does exist on both surfaces
 * (`BaseLayout` wraps every page in `<ContainerProvider containerName="main">`),
 * so `useIsMobile()`'s container default would not throw — but `main` is the
 * page's whole content column. On the model surface the chrome sits in a sidebar
 * three to eight times narrower than that, so a query against `main` reports
 * "desktop" for a 320px-wide bar. A viewport media query is wrong for the same
 * reason in the other direction. The chrome's own inline size is the only box
 * that answers the question the chrome is actually asking, on BOTH surfaces —
 * so the caller measures it with the repo's `useResizeObserver` and feeds it
 * here. That is the same mechanism `useContainerQuery` uses (a `ResizeObserver`
 * `inlineSize` compared against the px scale), pointed at the right box.
 */
import { breakpoints } from '~/utils/tailwind';

/**
 * The px breakpoint scale, parsed from the single-sourced JSON. Exported so a
 * test can pin that this module and Tailwind cannot drift apart.
 */
export const CHROME_BREAKPOINTS = {
  xs: parseInt(breakpoints.xs, 10),
  sm: parseInt(breakpoints.sm, 10),
  md: parseInt(breakpoints.md, 10),
  lg: parseInt(breakpoints.lg, 10),
  xl: parseInt(breakpoints.xl, 10),
} as const;

/**
 * Width tier of the chrome bar itself. `base` is "narrower than the smallest
 * named breakpoint" — the 360px phone AND the desktop model sidebar both land
 * there, which is the point: they are the same layout problem.
 *
 * Tier semantics follow Tailwind's (a tier applies AT its breakpoint and above),
 * not Mantine's `hiddenFrom`/`visibleFrom`.
 */
export type ChromeSizeTier = 'base' | 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export interface ChromeGeometry {
  tier: ChromeSizeTier;
  /**
   * F3 — render the NATIVE MOBILE SHELL (back chevron · centered tappable app name ·
   * ⋮ that also carries the platform nav) instead of the desktop breadcrumb chrome.
   * True when the bar's own measured inline size is below `sm` (768).
   *
   * 🔴 IT IS NOT `tier === 'base' || tier === 'xs'`, AND THE DIFFERENCE IS THE WHOLE
   * POINT: AN UNMEASURED BAR IS NOT COMPACT. `tier` resolves an unmeasured width (0 —
   * SSR, and the first client render before the `ResizeObserver` fires) to `base`,
   * which is correct for `tier`'s job: `base` reproduces the pre-F1 pinned name/menu
   * widths, so the server HTML is byte-identical to what it always was. Reusing that
   * for `compact` would make the SERVER render the mobile shell for everyone and then
   * swap it for a breadcrumb one frame later on every desktop page load — a
   * structural DOM swap, not a `max-width` change, on the majority surface.
   *
   * So `compact` is false at width 0 and the unmeasured render is the DESKTOP one.
   * The cost is the mirror image and it is the one worth paying: a phone paints the
   * breadcrumb for the single frame before the observer reports, then swaps. The
   * measurement lands in the `requestAnimationFrame` `useResizeObserver` batches into,
   * so it is one frame, and it lands on the smaller audience.
   *
   * Consequence worth stating because it is easy to misread from the tier table: a
   * 340px MODEL SIDEBAR is `tier: 'base'` AND `compact: true`. The chrome still does
   * not give it the mobile shell — the caller gates on `isPage && compact`, because
   * the shell REPLACES a breadcrumb that only the full-page surface has, and "back to
   * the Marketplace" is not a meaningful action from a model page. `compact` answers
   * "is this bar narrow"; the surface question is the caller's.
   */
  compact: boolean;
  /**
   * `max-width` (px) for the host-rendered app-name label and for the
   * breadcrumb's trailing app-name crumb — the two places a publisher-controlled
   * string is rendered in the bar. `undefined` means UNCAPPED: at `xl` the row
   * has more slack than any sanitized name can consume, and overflow is still
   * impossible because both nodes carry Mantine's `truncate`
   * (`overflow: hidden`, which zeroes a flex item's automatic minimum size) inside
   * a `minWidth: 0` flex parent.
   */
  nameMaxWidth: number | undefined;
  /**
   * Width (px) of the platform-nav dropdown. It renders publisher-controlled app
   * names ("Recently run"), so it is the one dropdown whose useful width depends
   * on how much room the surface has. The ⋮ overflow menu deliberately keeps its
   * fixed width — every label in it is short, host-authored and fixed, so there is
   * nothing width-dependent about it.
   */
  navMenuWidth: number;
}

/**
 * The tier table. `nameMaxWidth` is non-decreasing across tiers by construction;
 * a unit test pins that so a future edit cannot make a wider bar truncate harder.
 *
 * 🔴 `base` REPRODUCES THE PRE-CHANGE PINNED VALUES (name 160, menu 200). That is
 * deliberate and load-bearing in two ways: an unmeasured chrome (SSR, and the
 * first client render before the `ResizeObserver` has fired) resolves to `base`,
 * so the server HTML and the first client paint are byte-identical to what they
 * were before this module existed — no hydration mismatch, and no need to pair
 * this with `useIsClient` the way a `useMediaQuery`-driven value would need to be.
 * And the narrow model sidebar, the common case, keeps exactly the geometry it
 * shipped with.
 */
// `compact` is omitted from the row shape on purpose: it is NOT a tier property. It is
// derived from the raw width in `resolveChromeGeometry`, because it has to distinguish
// "measured narrow" from "not measured yet" and both of those resolve to the `base`
// row. Putting it in the table would collapse that distinction.
const TIERS: ReadonlyArray<
  { tier: ChromeSizeTier; min: number } & Omit<ChromeGeometry, 'tier' | 'compact'>
> = [
  { tier: 'xl', min: CHROME_BREAKPOINTS.xl, nameMaxWidth: undefined, navMenuWidth: 280 },
  { tier: 'lg', min: CHROME_BREAKPOINTS.lg, nameMaxWidth: 560, navMenuWidth: 280 },
  { tier: 'md', min: CHROME_BREAKPOINTS.md, nameMaxWidth: 440, navMenuWidth: 260 },
  { tier: 'sm', min: CHROME_BREAKPOINTS.sm, nameMaxWidth: 320, navMenuWidth: 240 },
  { tier: 'xs', min: CHROME_BREAKPOINTS.xs, nameMaxWidth: 240, navMenuWidth: 220 },
  { tier: 'base', min: 0, nameMaxWidth: 160, navMenuWidth: 200 },
];

/**
 * Resolve the chrome's width tier from its own measured inline size.
 *
 * `0` (and anything non-finite or negative — an unmeasured ref, an SSR render,
 * a `display: none` ancestor) resolves to `base`, the most conservative tier.
 */
export function resolveChromeTier(inlineSize: number): ChromeSizeTier {
  return resolveChromeGeometry(inlineSize).tier;
}

/** Resolve the whole geometry set from the chrome's own measured inline size. */
export function resolveChromeGeometry(inlineSize: number): ChromeGeometry {
  const width = Number.isFinite(inlineSize) && inlineSize > 0 ? inlineSize : 0;
  // 🔴 `width > 0` is the UNMEASURED guard, not defensive noise — see the `compact`
  // doc comment. `0` means "nobody has measured this bar yet", which must resolve to
  // the desktop chrome so SSR and the first client paint are unchanged.
  const compact = width > 0 && width < CHROME_BREAKPOINTS.sm;
  // TIERS is ordered widest-first, so the first match is the largest breakpoint
  // at or below `width`; the `base` row's min of 0 makes the loop total.
  for (const row of TIERS) {
    if (width >= row.min) {
      return {
        tier: row.tier,
        compact,
        nameMaxWidth: row.nameMaxWidth,
        navMenuWidth: row.navMenuWidth,
      };
    }
  }
  /* istanbul ignore next — unreachable: the `base` row matches every width >= 0 */
  return { tier: 'base', compact, nameMaxWidth: 160, navMenuWidth: 200 };
}
