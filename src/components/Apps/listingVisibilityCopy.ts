import type { AppListingVisibility } from '~/shared/utils/app-listing-visibility';
import {
  APP_LISTING_VISIBILITIES,
  listingVisibilityRank,
  maxVisibilityForStatus,
} from '~/shared/utils/app-listing-visibility';

/**
 * The owner-facing COPY and OPTION-ENABLEMENT for the per-listing visibility level.
 *
 * 🔴 WHY THIS IS A PURE MODULE AND NOT TERNARIES IN THE PANEL. The browser-mode component
 * suites are REPORT-ONLY in CI (`preview / component-tests`), and on this workstation they
 * cannot run at all — `browserType.launch` fails because the nix
 * `playwright-browsers` derivation's layout does not match the revision the npm package
 * expects, and CLAUDE.md is explicit that bumping that pin is not self-contained. So any
 * claim that lives only inside a `.tsx` branch is a claim nothing blocking will ever check.
 * Every decision below is therefore a function, covered by the BLOCKING node `unit`
 * project. This is the same reasoning `withdrawSuccessMessage` already gives in
 * `listingPublishingActions.ts`, applied to a surface with more copy and more branches.
 *
 * 🔴 NOTHING HERE RE-DERIVES THE CEILING OR THE COHORT MAP (D6). The enablement question
 * is answered by {@link maxVisibilityForStatus} and {@link listingVisibilityRank} — the
 * same two functions the server read and the server write use. A second implementation of
 * "may this listing be `public` yet?" is exactly how a `draft` + `public` selector would
 * come to offer publishing content no moderator has seen.
 */

/** One row of the level selector: the level, whether it may be chosen, and why not. */
export type VisibilityOption = {
  value: AppListingVisibility;
  label: string;
  /** What choosing this level actually does, in the owner's terms. */
  description: string;
  /** False ⇒ above this listing's review ceiling. */
  enabled: boolean;
  /** Present only when `enabled` is false: why it is unavailable, and what unlocks it. */
  disabledReason?: string;
};

/** The short human label for a level. */
export function visibilityLevelLabel(level: AppListingVisibility): string {
  switch (level) {
    case 'private':
      return 'Private';
    case 'moderators':
      return 'Moderators only';
    case 'testers':
      return 'Testers';
    case 'public':
      return 'Everyone';
  }
}

/**
 * What a level DOES, phrased for the owner.
 *
 * 🔴 `private` IS A DISCOVERABILITY CLAIM, NEVER AN ACCESS-CONTROL ONE — the single most
 * important sentence on this surface, and an explicit requirement carried over from the
 * design round. The column is consulted by the STORE READ only; the run route never looks
 * at it. So an approved listing set to `private` disappears from the store and from search,
 * and anyone who already holds its URL can still open and run it. Copy that said "nobody
 * else can see it" or "only you can access it" would be a security promise the system does
 * not make, and an owner relying on it could expose something they believed was shut.
 */
export function visibilityLevelDescription(level: AppListingVisibility): string {
  switch (level) {
    case 'private':
      return 'Not listed in the store or search. Anyone who already has the link can still open it.';
    case 'moderators':
      return 'Visible in the store to moderators only.';
    case 'testers':
      return 'Visible to users with app testing enabled.';
    case 'public':
      return 'Visible to everyone the store admits.';
  }
}

/**
 * Why a level above the ceiling is unavailable, and what changes it.
 *
 * 🔴 IT MUST NAME THE REASON, NOT JUST DISABLE THE OPTION (D7). The review ceiling is a
 * deliberate narrowing of D2 ("the owner sets freely within the enum"), so an owner who
 * cannot pick `Everyone` on a draft is hitting a rule, not a bug — and a greyed-out option
 * with no explanation reads as the latter. Returns `null` for a status where no level is
 * settable at all, which is a different situation (the control is not offered).
 */
export function visibilityCeilingReason(status: string): string | null {
  const ceiling = maxVisibilityForStatus(status);
  if (ceiling === null) return null;
  if (ceiling === 'public') return null;
  return 'Available once this app has been approved by a moderator.';
}

/**
 * The full option list for a listing in `status`, in widening order.
 *
 * 🔴 ORDER IS `APP_LISTING_VISIBILITIES`, WHICH IS THE WIDENING ORDER, and it is not
 * re-spelled here — the enum's own invariant test pins that its ranks increase. A selector
 * that listed them in a different order would make "wider" and "narrower" unreadable.
 */
export function visibilityOptionsFor(status: string): VisibilityOption[] {
  const ceiling = maxVisibilityForStatus(status);
  const reason = visibilityCeilingReason(status);
  return APP_LISTING_VISIBILITIES.map((value) => {
    // ⚠️ `ceiling === null` IS UNREACHABLE FROM BOTH CALL SITES, AND IT HAS NO SURVIVING
    // JUSTIFICATION. It is kept only so this stays a TOTAL function.
    //
    // Its original reason was "so the surface can still SHOW the current level on a rejected
    // or removed listing" — and no surface does that: the owner modal opens only behind
    // `showVisibility` and the moderator modal only behind `isVisibilityEligibleListingStatus`,
    // both of which are exactly `ceiling !== null`. A round-0 reachability pass found it; the
    // claim is retracted rather than replaced, because reaching for a fresh rationale under
    // pressure to supply one is how a guard acquires a reason it never had. If a future
    // surface genuinely needs to display a level on an ineligible status, THAT change can
    // state the reason.
    const enabled =
      ceiling !== null && listingVisibilityRank(value) <= listingVisibilityRank(ceiling);
    return {
      value,
      label: visibilityLevelLabel(value),
      description: visibilityLevelDescription(value),
      enabled,
      ...(enabled
        ? {}
        : { disabledReason: reason ?? 'This listing’s status does not allow a visibility level.' }),
    };
  });
}

/**
 * The owner-facing summary of the CURRENT level, for the control's label.
 *
 * 🔴 `null` IS RENDERED AS ITS OWN STATE, NOT AS `private`. An unset level means "no choice
 * expressed" and resolves to the pre-feature rule for the row's status — which for an
 * approved listing is *visible to everyone*, i.e. the OPPOSITE of `private`. Preselecting
 * `Private` for a `null` row would show every existing owner a value they never chose, and
 * one click of "save" would then genuinely hide their live app.
 */
export function visibilitySummaryLabel(
  visibility: AppListingVisibility | null,
  status: string
): string {
  if (visibility !== null) return visibilityLevelLabel(visibility);
  return maxVisibilityForStatus(status) === 'public' ? 'Everyone (default)' : 'Not set';
}

/**
 * The post-approval prompt for a level that SURVIVED review — finding F11.
 *
 * 🔴 THIS IS THE WHOLE OWNER-SIDE SIGNAL FOR A REAL TRAP, and it is required behaviour
 * rather than a nicety. `maxVisibilityForStatus`'s own header records it: nothing clears
 * the column at approval, because that would mean the approve path writing this column —
 * the eight-scattered-writes problem the `@no-type` shape exists to avoid — and it would
 * also discard a deliberate choice from an owner who really did want `moderators` on a live
 * app. So an app approved while set to `moderators` goes LIVE VISIBLE TO MODERATORS ONLY,
 * and without this prompt the owner's only clue is that nobody ever uses their app.
 *
 * Fires only for a level strictly NARROWER than the ceiling on an `approved` listing, so a
 * deliberate `public` (or an unset `null`, which already resolves to the public baseline)
 * says nothing.
 */
export function visibilityPostApprovalPrompt(
  visibility: AppListingVisibility | null,
  status: string
): string | null {
  if (status !== 'approved' || visibility === null) return null;
  if (listingVisibilityRank(visibility) >= listingVisibilityRank('public')) return null;
  return `This app is approved, but its visibility is still set to ${visibilityLevelLabel(
    visibility
  )} — so most people cannot find it in the store. Set it to Everyone when you are ready.`;
}

/** The store badge for a restricted listing: a short label plus the tooltip explaining it. */
export type VisibilityBadge = { label: string; tooltip: string };

/**
 * The badge a store card or detail page shows for a listing's RESTRICTED audience, or
 * `null` to show nothing.
 *
 * Takes the viewer-scoped `restrictedAudience` from the DTO, never the raw level: the server
 * has already decided whether this viewer may know it (`restrictedAudienceForViewer`), so a
 * `null` here covers unset, `public`, and "this viewer is not told".
 *
 * 🔴 `private` IS LABELLED "Unlisted", NOT {@link visibilityLevelLabel}'s "Private". The
 * owner's selector names the setting; this badge describes the listing to someone looking
 * at it, and "Private" would claim an access control the system does not enforce — anyone
 * with the URL can still open it. See {@link visibilityLevelDescription}, which is reused
 * as the tooltip so the copy is spelled once.
 */
export function visibilityBadgeFor(
  restrictedAudience: AppListingVisibility | null
): VisibilityBadge | null {
  // Typed as the FULL level set, not just the restricted subset, so `public` is handled by
  // an explicit branch rather than by falling out of a switch with no case — a `public`
  // that reached here at runtime must render nothing, never `undefined`.
  if (restrictedAudience === null || restrictedAudience === 'public') return null;
  // No `default`: the switch is exhaustive over the remaining levels, so a new restricted
  // level is a compile error here rather than a silently missing badge.
  switch (restrictedAudience) {
    case 'testers':
      return { label: 'Testers only', tooltip: visibilityLevelDescription('testers') };
    case 'moderators':
      return { label: 'Moderators only', tooltip: visibilityLevelDescription('moderators') };
    case 'private':
      return { label: 'Unlisted', tooltip: visibilityLevelDescription('private') };
  }
}
