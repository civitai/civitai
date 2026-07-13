/**
 * App Store Listings (W13 post-approval mgmt, Phase 3) — OWNER-control view model
 * (pure, React-free). Given a my-submissions row's TRUE listing status
 * (`AppListing.status`, distinct from the publish-REQUEST status) and its
 * most-recent moderation-event action, decide which owner affordance the row
 * offers:
 *
 *   - `live`         — listing is `approved` (visible in the store) → **Unpublish**.
 *   - `owner-hidden` — listing is `removed` AND its last moderation event is the
 *                      owner's own `owner-unpublish` → **Republish** (the server
 *                      allows republish ONLY here).
 *   - `mod-removed`  — listing is `removed` but the last event is a moderator
 *                      takedown (`delist`/`purge`/…), OR there is no event → NO
 *                      republish (it would 403); show a "removed by a moderator"
 *                      state linking to the history.
 *   - `inactive`     — any other listing status (draft/pending/rejected/…) → no
 *                      owner takedown affordance.
 *
 * Extracted so this load-bearing owner-hidden-vs-mod-removed distinction (which
 * gates the Republish button) is covered by the BLOCKING node `unit` project — the
 * civitai browser-mode component suites are report-only. The republish eligibility
 * here is the CLIENT mirror of the server guard in
 * `offsite-moderation.service.ts#republishOwnListing` (last event must be
 * `owner-unpublish`); the server remains authoritative (a race still 403s, surfaced
 * as a mutation error).
 */

/** The moderation-event action that marks an owner-initiated (not mod) unpublish. */
export const OWNER_UNPUBLISH_ACTION = 'owner-unpublish';

export type OwnerListingState = 'live' | 'owner-hidden' | 'mod-removed' | 'inactive';

/**
 * Classify a listing for the owner-control affordances. `listingStatus` is the real
 * `AppListing.status`; `lastModerationAction` is the listing's most-recent
 * moderation-event action (null when it has none / isn't removed).
 */
export function ownerListingState(input: {
  listingStatus: string | null | undefined;
  lastModerationAction: string | null | undefined;
}): OwnerListingState {
  const status = input.listingStatus ?? null;
  if (status === 'approved') return 'live';
  if (status === 'removed') {
    return input.lastModerationAction === OWNER_UNPUBLISH_ACTION ? 'owner-hidden' : 'mod-removed';
  }
  return 'inactive';
}

/** True when the owner may unpublish (hide) the listing — only a live listing. */
export function canOwnerUnpublish(state: OwnerListingState): boolean {
  return state === 'live';
}

/**
 * True when the owner may republish the listing — ONLY an owner-hidden one. A
 * mod-removed listing is deliberately excluded (the server FORBIDS it).
 */
export function canOwnerRepublish(state: OwnerListingState): boolean {
  return state === 'owner-hidden';
}

/** Pill descriptor for a removed listing's owner-facing status badge (label + Mantine color). */
export type OwnerStateChip = { label: string; color: string };

/**
 * The status badge to show for a removed listing (overriding the request-status
 * chip, which would misleadingly read `approved`). Returns null for `live`/`inactive`
 * (the caller keeps the normal request-status chip).
 */
export function ownerStateChip(state: OwnerListingState): OwnerStateChip | null {
  switch (state) {
    case 'owner-hidden':
      return { label: 'unpublished', color: 'gray' };
    case 'mod-removed':
      return { label: 'removed by a moderator', color: 'red' };
    default:
      return null;
  }
}
