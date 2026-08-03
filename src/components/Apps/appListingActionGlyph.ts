import {
  IconExternalLink,
  IconEye,
  IconInfoCircle,
  IconPlayerPlay,
  IconPlugConnected,
} from '@tabler/icons-react';
import type { Icon } from '@tabler/icons-react';
import type { ListingCtaAction } from '~/components/Apps/appListingCardView';
import type { DetailActionMode } from '~/components/Apps/appListingDetailView';

/**
 * The primary-action GLYPH vocabulary — the single source of truth for "which
 * icon does this CTA wear", shared by the store card and the listing detail.
 * Same shape as `marketplaceCategoryIcons.ts`: one module carrying both the
 * mapping logic and the icon record it resolves to.
 *
 * WHY THIS EXISTS. civitai #3391 removed the kind + category badges from both
 * `AppListingCard` and `AppListingDetailBody`, on the stated grounds that the
 * on-site/off-site kind signal now rides the CTA itself (Open vs Visit ↗).
 * Measured on prod, it did not: `AppListingDetailBody`'s `open` and `visit`
 * branches rendered the byte-identical `IconExternalLink`, so the only
 * difference between "runs here, in-site" and "leaves the site" was one word of
 * button copy. The card was silent in the other direction — its external branch
 * carried an icon and its internal branch carried none.
 *
 * Both view-models ALREADY carry the discriminator (`DetailActionMode` /
 * `ListingCtaAction`); the components threw it away at the icon. So the fix is a
 * mapping, and the invariant worth pinning is that the in-site and off-site
 * glyphs are DIFFERENT.
 */
export type PrimaryActionGlyph = 'launch' | 'external' | 'connect' | 'info' | 'view';

/**
 * Glyph → Tabler icon.
 *
 * 🔴 `launch` and `external` must stay DIFFERENT icons. The whole point of the
 * vocabulary is that "runs here" and "leaves the site" look different — mapping
 * them to the same icon reinstates exactly the defect #3391's badge removal
 * assumed was already handled. Pinned in
 * `__tests__/appListingActionGlyph.test.ts`.
 */
export const ACTION_GLYPH_ICONS: Record<PrimaryActionGlyph, Icon> = {
  /** In-site nav to the in-host page runner — a play/run affordance, no new tab. */
  launch: IconPlayerPlay,
  /** Leaves civitai.com in a new tab (`target="_blank"` + `rel="noopener noreferrer"`). */
  external: IconExternalLink,
  /** OAuth connect affordance (stubbed until the cutover wires it). */
  connect: IconPlugConnected,
  /** Informational — no launch, no navigation off-site, and no target to go to. */
  info: IconInfoCircle,
  /**
   * "Read about it" — an in-site hop to the unified listing detail.
   *
   * 🔴 Distinct from `info`, and it must stay `IconEye`. #3539's product-feedback
   * pass shipped `IconEye` for the card's "View details" CTA and for the recents
   * rail's `view` action (`RECENT_ACTION_ICONS` in `RecentlyOpenedApps.tsx`), so
   * this is the SITE's established vocabulary, not a fresh choice. `info` is the
   * detail page's *inert* affordance ("Runs on model pages" — no href at all);
   * collapsing the two would silently repaint every card's View-details CTA.
   */
  view: IconEye,
};

/**
 * Detail-page primary action → glyph.
 *
 * `open` is in-site nav to `/apps/run/<slug>` (no `target`); `visit` is the
 * external new-tab anchor. They MUST NOT share a glyph — that equality is the
 * defect this module exists to prevent regressing.
 *
 * 🔴 Resolve this from the mode the RENDERING BRANCH has established, not from a
 * mode a later guard may still reject. `DetailPrimaryAction.href` is optional,
 * so `PrimaryAction`'s `mode === 'open' && action.href` branch can in principle
 * be skipped while the mode is still `'open'` — resolving the glyph once, up
 * front, would then paint a launch icon on the informational fallback. Not
 * reachable from today's `getDetailPrimaryAction` (every `open`/`visit` return
 * sets an href), which is precisely why it would be easy to introduce later.
 */
export function detailActionGlyph(mode: DetailActionMode): PrimaryActionGlyph {
  switch (mode) {
    case 'open':
      return 'launch';
    case 'visit':
      return 'external';
    case 'connect':
      return 'connect';
    case 'info':
      return 'info';
  }
}

/**
 * Store-card CTA action → glyph. Same vocabulary as the detail page, so a card
 * and the detail it links to can never disagree about what an app's CTA means.
 *
 * `detail` ("View details" — the unified listing detail) maps to `view`
 * (`IconEye`), NOT `info`. See the `view` entry above: `IconEye` is what the site
 * already ships for this action, on both the card and the recents rail.
 *
 * `AppListingCard` is the live caller. `getListingCta` still does not emit
 * `'connect'` (the off-site OAuth case routes to `'detail'`), so that arm remains
 * unreachable from live data; it is mapped for totality over the type.
 */
export function cardActionGlyph(action: ListingCtaAction): PrimaryActionGlyph {
  switch (action) {
    case 'open':
      return 'launch';
    case 'visit':
      return 'external';
    case 'connect':
      return 'connect';
    case 'detail':
      // 🔴 'view' (IconEye), NOT 'info'. This arm shipped as 'info' in #3540 while
      // it had no caller; #3539 had meanwhile shipped IconEye on the card's real
      // "View details" CTA. Wiring the card to the old mapping would have silently
      // repainted every such CTA — a regression against a deliberate product call,
      // introduced by a module written to be wired up. Corrected before its first
      // caller (this file's own card) exists.
      return 'view';
  }
}
