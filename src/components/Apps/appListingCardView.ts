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
 *   - off-site with an https `externalUrl` → **Visit ↗** → external anchor
 *     (direct primary action). 🔴 The presence of a destination decides this.
 *   - off-site with no usable target (missing / non-https url) → **View
 *     details** → the unified detail (the DTO already null-guards non-https —
 *     we re-guard; the detail page shows the informational state).
 *
 * 🔴 A listing with a linked OAuth client used to route to "View details"
 * UNCONDITIONALLY, on the premise that "the Connect affordance lives on the
 * detail page". That affordance was a dead stub, so the card handed the viewer a
 * detail page with nothing on it — the card half of the same defect. The detail
 * now renders a real `Visit ↗` for any off-site listing carrying an https
 * `externalUrl` (see `appListingDetailView`), so the card matches it: an
 * OAuth-connected listing with a destination gets the direct Visit, and only a
 * listing with NO destination falls back to the detail. Card and detail must not
 * disagree about whether an app is reachable.
 * Every CTA now has a working `href` (never actionless). The card ALSO links its
 * title to the detail (via `getListingDetailHref`) so the detail is reachable
 * even when the primary CTA is a direct Open / Visit.
 */

import type {
  ListingCard,
  ListingRecommendRollup,
} from '~/server/schema/blocks/app-listing-read.schema';
import { EMBEDDED_KIND_LABEL, STANDALONE_KIND_LABEL } from '~/components/Apps/listingKindLabels';
import { abbreviateNumber } from '~/utils/number-helpers';
import type { AppListingStatus } from '~/server/services/blocks/app-listing-status.constants';

/** Kind badge shown on the card face. */
export type ListingBadgeKind = 'onsite' | 'offsite';
export type ListingBadge = { label: string; kind: ListingBadgeKind };

/**
 * The kind badge: on-site apps read "Embedded"; every off-site app reads "Standalone".
 *
 * 🔴 BOTH BRANCHES NOW RESOLVE FROM `listingKindLabels`. The onsite branch used to
 * return a hardcoded `'App'` — the CORRECT-looking word, which is why no copy sweep
 * ever surfaced it and why the ledger's retired-wording rule could not see it either.
 * A literal here is what let this surface and `appListingDetailRows` disagree about
 * the same listing before, so neither side spells the word any more.
 *
 * 🔴 Off-site used to fork into two BADGES — "Connect app" (a linked OAuth
 * client) vs "Off-site" (no client) — derived from `connectClientId`. That fork
 * is removed: `offsite` is one kind. (Those two names are the HISTORICAL labels;
 * the surviving one has since been renamed "Standalone" as user-facing copy.)
 * The word here is the SAME word the store's kind filter already uses
 * (`KindFilterButtons`' "Standalone"), which is what makes the parent label true
 * of the whole category again — under the fork it was only true of one child,
 * while the submit flow REQUIRES an OAuth client and therefore minted nothing
 * but the other one.
 */
export function getListingBadge(card: Pick<ListingCard, 'kind' | 'kindData'>): ListingBadge {
  if (card.kindData.kind === 'onsite') return { label: EMBEDDED_KIND_LABEL, kind: 'onsite' };
  return { label: STANDALONE_KIND_LABEL, kind: 'offsite' };
}

/**
 * Recommend rollup → display label. `recommendPct` is `null` when there are no
 * reviews yet (metric row absent OR zero counts) — render "No reviews yet"
 * rather than a misleading "0% recommend". Otherwise a Steam-style
 * "N% recommend (M)" with the review count.
 */
export function getRecommendLabel(recommend: ListingRecommendRollup, reviewCount: number): string {
  if (recommend.recommendPct == null) return 'No reviews yet';
  const pct = Math.round(recommend.recommendPct * 100);
  return `${pct}% recommend (${reviewCount.toLocaleString()})`;
}

/**
 * Play count → display label (`0 plays` / `1 play` / `12.4k plays`), or `null` when
 * there is no honest number to print.
 *
 * 🔴 `null` IN, `null` OUT — AND THAT IS AN OPERATOR OVERRIDE RECORDED AS A
 * DECISION, NOT A FORMATTING DERIVATION. `ListingCard.openCount` is `null` exactly
 * when the count is STRUCTURALLY UNMEASURABLE: an off-site listing's CTA is a
 * third-party `target="_blank"` anchor, so no on-platform request follows the click
 * and nothing observes it. The operator's call (2026-09-06) is that such a card
 * renders NO play stat at all — a `0` there would read as "nobody has ever used
 * this app" about an app we simply cannot measure. The DTO says the same thing in
 * two places (`app-listing-read.schema.ts`'s `openCount`, and
 * `app-listing.service.ts`'s `cardOpenCount`, whose own comment promises "the
 * renderer omits the stat row"); this function is where that promise becomes code.
 *
 * 🔴 THE DECISION LIVES HERE RATHER THAN IN THE COMPONENT ON PURPOSE, and it is the
 * same reasoning `appListingStatChips.ts` was extracted for. `AppListingCard` is
 * only covered by the browser `component` project, which is REPORT-ONLY; the node
 * `unit` project is the one that reddens a `main` push. A null-vs-zero rule
 * expressed as JSX (`card.openCount != null && …`) would be invisible to the only
 * tier that ever goes red on its own. Expressed as this function's return type it
 * is pinned in `__tests__/appListingCardView.test.ts`, and the component is left
 * with a branch that has nothing to get wrong.
 *
 * 🔴 AND `0` IS A REAL ANSWER — the mirror half, equally load-bearing. An ON-SITE
 * listing nobody has opened yet is a genuine zero (the COALESCE-to-0 reading
 * `cardOpenCount` documents), so this returns "0 plays" rather than treating a
 * falsy value as absence. A truthiness test here (`if (!openCount) return null`)
 * would collapse the two cases and is exactly what the guard below refuses.
 *
 * 🔴 ABBREVIATED, NOT `toLocaleString()`-ED, which is a deliberate DIVERGENCE from
 * `getRecommendLabel` above rather than an inconsistency. A review count is an
 * exactness claim inside a parenthetical; a play count is a magnitude on a dense
 * grid tile, where "12.4k" reads at a glance and "12,431" does not.
 * `abbreviateNumber` is the repo-wide helper for that (`~/utils/number-helpers`) —
 * what every other public count on the platform renders through — so this is reuse,
 * not a second formatter.
 *
 * Pluralisation reads the RAW value, not the abbreviated string: exactly 1 is
 * "1 play"; everything else — including 0, and including 1000 (which abbreviates to
 * "1k") — is "plays".
 */
export function getPlayCountLabel(openCount: number | null): string | null {
  if (openCount == null) return null;
  return `${abbreviateNumber(openCount)} ${openCount === 1 ? 'play' : 'plays'}`;
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

  // Off-site — ONE kind. The destination decides: an OAuth-connected app is
  // reached at its own address exactly like a plain external link (it starts its
  // own OAuth flow from there). Mirrors `getDetailPrimaryAction`; do NOT
  // reintroduce a `connectClientId` test above this line, or the card and the
  // detail disagree again. (The card DTO does not even carry that field.)
  const href = safeExternalHref(card.kindData.externalUrl);
  if (href) {
    return { label: 'Visit', action: 'visit', href, external: true };
  }
  // No usable external target (missing / non-https) → the unified detail, which
  // shows the informational / connect-stub state.
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
 *   - on-site  → `/apps/<appBlockId>/edit`, which now 302s to the CANONICAL listing-keyed
 *     editor `/apps/listing/<appListingId>/edit` whenever the block has a listing. That
 *     page opens on the DETAILS tab (it is the one tab every kind and every role can
 *     always open); it used to open on the manifest tab, and this comment said so long
 *     after it stopped being true. Null when the on-site listing
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
    return kindData.appBlockId ? `/apps/${encodeURIComponent(kindData.appBlockId)}/edit` : null;
  }
  return `/apps/submit?edit=${encodeURIComponent(listingId)}`;
}

// ── Action-row geometry (S7) — RETIRED, and this note is the tombstone ──────
//
// 🔴 FIVE EXPORTS LIVED HERE. FOUR ARE DELETED; ONE MOVED. The distinction is the
// whole point of writing this down, and an earlier draft of this note got it wrong
// — it said "all five are deleted" and then listed four names plus a TEST, which is
// not an export at all.
//
//   DELETED, no replacement anywhere:
//     `LISTING_ROLLUP_MIN_WIDTH_PX` (70) — the rollup's enforced min-width floor
//     `LISTING_ACTIONS_WIDEST_PX`   (184) — the measured widest action cluster
//     `LISTING_ROLLUP_HIDE_BELOW_PX`(264) — the derived container-query threshold
//     `listingRollupHideThreshold()`      — the function that derived it
//
//   MOVED, same name, new home:
//     `LISTING_ACTION_ROW_GAP_PX`   (10) → `~/components/Apps/appListingCardGeometry.ts`,
//     where the card reads it as the action row's `gap`. It is still live geometry;
//     it just is not rollup-threshold arithmetic any more. 🔴 IF YOU CAME HERE
//     LOOKING FOR THE ROW GAP, IMPORT IT FROM THERE — do NOT mint a second copy,
//     which is exactly the two-copies drift the geometry module exists to remove.
//
// Also deleted, though it was never an export: the spelling guard in
// `__tests__/appListingCardView.test.ts` that asserted the component's `@[264px]`
// Tailwind class agreed with the JS constant.
//
// Every one of them existed to let the recommend rollup and the CTA share the
// action row: a floor so a growing CTA could not starve the rollup, a container
// query hiding the rollup where even the floor did not fit, a measured
// action-cluster width to derive that threshold from, and a drift guard because a
// Tailwind arbitrary variant cannot read a JS constant. Moving the rollup up into
// the card's meta block removed the competition, and with it the entire
// apparatus. Deleting a derived number and its guard TOGETHER is the point — a
// surviving constant with no consumer is the shape that gets "fixed" back into
// use later.
//
// The geometry this card DOES still have — cover ratio, icon size, reserved title
// lines, action-row height / padding / gap / control size — lives in
// `~/components/Apps/appListingCardGeometry.ts`, which exists so the (later)
// `AppListingCardSkeleton` reserves the same numbers by import rather than by
// copy. This module is back to being the pure kind/CTA/label view-model its
// header describes.
