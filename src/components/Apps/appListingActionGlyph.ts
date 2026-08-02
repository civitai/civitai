import {
  IconExternalLink,
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
export type PrimaryActionGlyph = 'launch' | 'external' | 'connect' | 'info';

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
  /** Informational — no launch, no navigation off-site. */
  info: IconInfoCircle,
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
 * `detail` ("View details" — the unified listing detail) is informational, so it
 * shares the `info` glyph with the detail page's own informational mode.
 *
 * 🔴 NO LIVE CALLER YET. This half is consumed by the store-card PR that follows
 * (the card CTA collapse); it ships here so that PR imports this module rather
 * than editing it — the two changes are otherwise the same-file collision that
 * silently dropped a hunk from `GetStartedBody.tsx`. Its tests are therefore a
 * contract pin, not a regression gate, until the card reads through it.
 * Separately, `getListingCta` does not currently emit `'connect'` at all (the
 * off-site OAuth case routes to `'detail'`), so that arm is unreachable from
 * live data even after the card lands; it is mapped for totality over the type.
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
      return 'info';
  }
}
