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
 * CTA target policy (P2c — the unified dark listing detail now exists at
 * `/apps/store-preview/<slug>`, so every card can reach a real detail surface and
 * NO CTA is ever inert/disabled):
 *   - on-site + hasPage + canOpenPage → **Open** → `/apps/run/<slug>` (the LIVE
 *     W10 page route; itself flag-gated on `appBlocksPages`, so we only route
 *     there when the viewer can actually open it) — the direct primary action.
 *   - on-site otherwise (no page, or page but no `appBlocksPages`) → **View
 *     details** → `/apps/store-preview/<slug>` (the unified P2c detail).
 *   - off-site external-link (https) → **Visit ↗** → external anchor (direct
 *     primary action).
 *   - off-site external-link (missing / non-https url) → **View details** →
 *     the unified detail (the DTO already null-guards non-https — we re-guard;
 *     the detail page shows the informational state).
 *   - off-site connect → **View details** → the unified detail (the Connect
 *     affordance lives on the detail page).
 * Every CTA now has a working `href` (never actionless). The card ALSO links its
 * title to the detail (via `getListingDetailHref`) so the detail is reachable
 * even when the primary CTA is a direct Open / Visit.
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
  /** Navigation target — always present (the unified detail is always reachable). */
  href: string;
  /** True → open in a new tab as an external anchor (rel=noopener noreferrer). */
  external: boolean;
};

/**
 * The unified P2c listing detail (`/apps/store-preview/<slug>`). Every card can
 * reach it by slug — the honest, working detail surface that replaces the P2b
 * per-AppBlock / disabled stubs. `deIndex`-ed + mod-gated (dark), parallel to
 * the live `/apps` path; the default-`/apps` cutover is P2d.
 */
export function getListingDetailHref(slug: string): string {
  return `/apps/store-preview/${encodeURIComponent(slug)}`;
}

/**
 * Kind-aware primary CTA. `canOpenPage` mirrors the `appBlocksPages` feature
 * flag: when false the live page route 404s, so an on-site page app falls back
 * to "View details" (the unified detail) instead of a dead "Open" link. Every
 * non-direct case routes to the unified detail — no CTA is ever inert.
 */
export function getListingCta(
  card: Pick<ListingCard, 'slug' | 'kind' | 'kindData'>,
  opts: { canOpenPage: boolean }
): ListingCta {
  const detailHref = getListingDetailHref(card.slug);

  if (card.kindData.kind === 'onsite') {
    const { hasPage } = card.kindData;
    if (hasPage && opts.canOpenPage) {
      return {
        label: 'Open',
        action: 'open',
        href: `/apps/run/${encodeURIComponent(card.slug)}`,
        external: false,
      };
    }
    // No page, or page but the viewer can't open it → the unified detail.
    return { label: 'View details', action: 'detail', href: detailHref, external: false };
  }

  // Off-site.
  if (card.kindData.subKind === 'external-link') {
    const href = safeExternalHref(card.kindData.externalUrl);
    if (href) {
      return { label: 'Visit', action: 'visit', href, external: true };
    }
    // No usable external target (missing / non-https) → the unified detail.
    return { label: 'View details', action: 'detail', href: detailHref, external: false };
  }

  // Off-site connect (OAuth) — the Connect affordance lives on the detail page.
  return { label: 'View details', action: 'detail', href: detailHref, external: false };
}
