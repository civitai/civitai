/**
 * App Store Listings (W13) — P2b card VIEW MODEL (pure, React-free).
 *
 * The kind-aware badge / CTA / recommend-label logic for `AppListingCard`,
 * extracted into pure functions so the correctness gate lives in the node `unit`
 * project (the civitai browser-mode component suites are REPORT-ONLY / non-
 * blocking — so the real, blocking test coverage for this behaviour is here).
 *
 * DARK / parallel-run: consumed only by the mod-only `/apps/store-preview`
 * preview surface. The default `/apps` render (MarketplaceBody → AppBlockCard)
 * is untouched; the cutover is a later PR (P2d).
 *
 * CTA target policy (dark phase — no listing detail page exists yet, that's P2c):
 *   - on-site + hasPage + canOpenPage → **Open** → `/apps/run/<slug>` (the LIVE
 *     W10 page route; itself flag-gated on `appBlocksPages`, so we only route
 *     there when the viewer can actually open it).
 *   - on-site otherwise (no page, or page but no `appBlocksPages`) → **View
 *     details** → the EXISTING per-AppBlock detail page `/apps/<appBlockId>`
 *     (a real, working page — the honest dark-phase stub; P2c adds the unified
 *     `/apps/<slug>` listing detail).
 *   - off-site external-link (https) → **Visit ↗** → external anchor.
 *   - off-site external-link (missing / non-https url) → disabled "View details"
 *     (no target yet; the DTO already null-guards non-https — we re-guard).
 *   - off-site connect → disabled **Connect** (the connect flow / listing detail
 *     is P2c; rendered but inert in the preview).
 * A CTA with `disabled: true` renders as a non-actionable button (component wraps
 * it in a tooltip). Every card always has a CTA (never actionless).
 */

import type {
  ListingCard,
  ListingRecommendRollup,
} from '~/server/schema/blocks/app-listing-read.schema';

/** Kind badge shown on the card face. */
export type ListingBadgeKind = 'onsite' | 'connect' | 'external-link';
export type ListingBadge = { label: string; kind: ListingBadgeKind };

/**
 * The kind badge: on-site apps read "App"; off-site splits into the two
 * sub-kinds — an OAuth "Connect app" vs a plain "Off-site" external link.
 */
export function getListingBadge(card: Pick<ListingCard, 'kind' | 'kindData'>): ListingBadge {
  if (card.kindData.kind === 'onsite') return { label: 'App', kind: 'onsite' };
  return card.kindData.subKind === 'connect'
    ? { label: 'Connect app', kind: 'connect' }
    : { label: 'Off-site', kind: 'external-link' };
}

/**
 * Recommend rollup → display label. `recommendPct` is `null` when there are no
 * reviews yet (metric row absent OR zero counts) — render "No reviews yet"
 * rather than a misleading "0% recommend". Otherwise a Steam-style
 * "N% recommend (M)" with the review count.
 */
export function getRecommendLabel(
  recommend: ListingRecommendRollup,
  reviewCount: number
): string {
  if (recommend.recommendPct == null) return 'No reviews yet';
  const pct = Math.round(recommend.recommendPct * 100);
  return `${pct}% recommend (${reviewCount.toLocaleString()})`;
}

/**
 * https-only external-link guard. The public DTO already null-guards a non-https
 * `externalUrl`, but re-guard at the render boundary so a malformed/`javascript:`
 * value can never become an anchor `href` (defense in depth).
 */
export function safeExternalHref(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.startsWith('https://') ? url : null;
}

export type ListingCtaAction = 'open' | 'detail' | 'visit' | 'connect';

export type ListingCta = {
  /** Button copy. */
  label: string;
  /** Semantic action (drives icon choice + analytics later). */
  action: ListingCtaAction;
  /** Navigation target, or `undefined` when there is no working target yet. */
  href?: string;
  /** True → open in a new tab as an external anchor (rel=noopener noreferrer). */
  external: boolean;
  /** True → render a non-actionable (inert) button; there's no target in the dark phase. */
  disabled: boolean;
};

/** The per-AppBlock detail page that on-site listings stub to during the dark phase. */
function onsiteDetailHref(appBlockId: string | null): string | undefined {
  return appBlockId ? `/apps/${encodeURIComponent(appBlockId)}` : undefined;
}

/**
 * Kind-aware primary CTA. `canOpenPage` mirrors the `appBlocksPages` feature
 * flag: when false the live page route 404s, so an on-site page app falls back
 * to "View details" instead of a dead "Open" link.
 */
export function getListingCta(
  card: Pick<ListingCard, 'slug' | 'kind' | 'kindData'>,
  opts: { canOpenPage: boolean }
): ListingCta {
  if (card.kindData.kind === 'onsite') {
    const { appBlockId, hasPage } = card.kindData;
    if (hasPage && opts.canOpenPage) {
      return {
        label: 'Open',
        action: 'open',
        href: `/apps/run/${encodeURIComponent(card.slug)}`,
        external: false,
        disabled: false,
      };
    }
    // No page, or page but the viewer can't open it → the detail stub.
    const href = onsiteDetailHref(appBlockId);
    return {
      label: 'View details',
      action: 'detail',
      href,
      external: false,
      disabled: !href,
    };
  }

  // Off-site.
  if (card.kindData.subKind === 'external-link') {
    const href = safeExternalHref(card.kindData.externalUrl);
    if (href) {
      return { label: 'Visit', action: 'visit', href, external: true, disabled: false };
    }
    // No usable external target (missing / non-https) — no detail page yet (P2c).
    return { label: 'View details', action: 'detail', href: undefined, external: false, disabled: true };
  }

  // Off-site connect (OAuth). The connect flow / listing detail is P2c — inert here.
  return { label: 'Connect', action: 'connect', href: undefined, external: false, disabled: true };
}
