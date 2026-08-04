/**
 * App Store Listings (W13) — P2b card VIEW MODEL (pure, React-free).
 *
 * The kind-aware badge / CTA / recommend-label logic for `AppListingCard`,
 * extracted into pure functions so the correctness gate lives in the node `unit`
 * project (the civitai browser-mode component suites are REPORT-ONLY / non-
 * blocking — so the real, blocking test coverage for this behaviour is here).
 *
 * LIVE (P2d cut over): this view-model now backs the DEFAULT `/apps` store grid
 * (`AppListingsMarketplaceBody` → `AppListingCard`), reading the unified
 * `AppListing` record over BOTH kinds. The page remains flag-gated (the App
 * Blocks Flipt segment + `deIndex`) — not "store-preview only" any more. The
 * unified DETAIL still lives at `/apps/store-preview/<slug>`
 * (`getListingDetailHref`).
 *
 * CTA target policy (P2c — the unified dark listing detail now exists at
 * `/apps/store-preview/<slug>`, so every card can reach a real detail surface and
 * NO CTA is ever inert/disabled):
 *   - on-site + hasPage + canOpenPage → **Open** → `/apps/run/<slug>` (the LIVE
 *     W10 page route; itself flag-gated on `appBlocksPages`, so we only route
 *     there when the viewer can actually open it) — the direct primary action.
 *   - on-site otherwise (no page, or page but no `appBlocksPages`) → **View
 *     details** → `/apps/store-preview/<slug>` (the unified P2c detail).
 *   - off-site, EITHER sub-kind, with an https `externalUrl` → **Visit ↗** →
 *     external anchor (direct primary action). 🔴 The sub-kind does NOT decide
 *     this; the presence of a destination does — see below.
 *   - off-site with no usable target (missing / non-https url, either sub-kind)
 *     → **View details** → the unified detail (the DTO already null-guards
 *     non-https — we re-guard; the detail page shows the informational state).
 *
 * 🔴 Connect used to route to "View details" UNCONDITIONALLY, on the premise
 * that "the Connect affordance lives on the detail page". That affordance was a
 * dead stub, so the card handed the viewer a detail page with nothing on it —
 * the card half of the same defect. The detail now renders a real `Visit ↗` for
 * any off-site listing carrying an https `externalUrl` (see
 * `appListingDetailView`), so the card matches it: a connect listing with a
 * destination gets the direct Visit, and only a listing with NO destination
 * falls back to the detail. Card and detail must not disagree about whether an
 * app is reachable.
 * Every CTA now has a working `href` (never actionless). The card ALSO links its
 * title to the detail (via `getListingDetailHref`) so the detail is reachable
 * even when the primary CTA is a direct Open / Visit.
 */

import type {
  ListingCard,
  ListingRecommendRollup,
} from '~/server/schema/blocks/app-listing-read.schema';
import type { AppListingStatus } from '~/server/services/blocks/app-listing-status.constants';

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

  // Off-site — BOTH sub-kinds. The destination decides, not the sub-kind: a
  // connect app is reached at its own address exactly like a plain external
  // link (it starts its own OAuth flow from there). Mirrors
  // `getDetailPrimaryAction`; do NOT reintroduce a sub-kind test above this
  // line, or the card and the detail disagree again.
  const href = safeExternalHref(card.kindData.externalUrl);
  if (href) {
    return { label: 'Visit', action: 'visit', href, external: true };
  }
  // No usable external target (missing / non-https, either sub-kind) → the
  // unified detail, which shows the informational / connect-stub state.
  return { label: 'View details', action: 'detail', href: detailHref, external: false };
}

// ---------------------------------------------------------------------------
// Owner "Edit" deep-link (Item 2) — pure gating + href builders, shared by the
// store card + detail. Mirrors the my-submissions edit gating
// (`MySubmissionsList` `showEdit` / `OffsiteSubmissionsList` `canEdit`): the
// owner can edit an app that is still editable (NOT mod-removed / rejected).
// ---------------------------------------------------------------------------

/** Statuses whose backing listing an owner can still edit (mirrors the my-
 *  submissions gating: a `removed`/`rejected` listing is NOT editable). */
const EDITABLE_LISTING_STATUSES: readonly AppListingStatus[] = ['draft', 'pending', 'approved'];

/**
 * Is a listing in an owner-editable status? The public store read path is
 * approved-only and its allowlist DTO deliberately carries NO status field, so
 * the card/detail call this with `null`/`undefined` → treated as editable (an
 * approved, live listing). A `removed` (mod takedown) / `rejected` status is
 * never editable — so if a status is ever threaded in, the gate stays correct.
 */
export function isEditableListingStatus(status?: AppListingStatus | null): boolean {
  if (status == null) return true;
  return EDITABLE_LISTING_STATUSES.includes(status);
}

/**
 * Show the owner "Edit" affordance? True only for the listing owner AND an
 * editable status. Non-owners never see it; a mod-removed / rejected listing is
 * not editable even for the owner (mirrors `showEdit` / `canEdit`).
 */
export function canOwnerEditListing(opts: {
  isOwner: boolean;
  status?: AppListingStatus | null;
}): boolean {
  return opts.isOwner && isEditableListingStatus(opts.status);
}

/**
 * The owner "Edit" deep-link target, by kind:
 *   - on-site  → `/apps/<appBlockId>/edit` (the UNIFIED tabbed editor — App/Manifest
 *     + Listing media; defaults to the manifest tab). Null when the on-site listing
 *     has no backing `appBlockId` (nothing to edit) — the caller then hides the
 *     button rather than routing to a dead link.
 *   - off-site → `/apps/submit?edit=<listingId>` (the off-site submit editor,
 *     keyed on the AppListing id — LEFT UNCHANGED; offsite is already unified).
 * Structurally accepts both the card + detail `kindData` (only `kind` +
 * `appBlockId` are read). `null` = no editable target → don't render Edit.
 */
export function getOwnerEditHref(
  kindData: { kind: 'onsite'; appBlockId: string | null } | { kind: 'offsite' },
  listingId: string
): string | null {
  if (kindData.kind === 'onsite') {
    return kindData.appBlockId
      ? `/apps/${encodeURIComponent(kindData.appBlockId)}/edit`
      : null;
  }
  return `/apps/submit?edit=${encodeURIComponent(listingId)}`;
}
