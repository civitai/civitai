import type { Prisma } from '@prisma/client';

/**
 * App Store Listings (W13) — "did the OWNER take this listing down, or did a MODERATOR?"
 *
 * 🔴 THE PROBLEM THIS EXISTS TO SOLVE. `app_listings.status = 'removed'` is written by
 * BOTH an owner self-unpublish (`unpublishOwnListing`) and a moderator takedown
 * (`delistListing` / `purgeListing`). The STATUS COLUMN CANNOT TELL THEM APART. The only
 * thing that can is the listing's MOST-RECENT `AppListingModerationEvent`: an
 * `owner-unpublish` there means the owner did it to themselves and may undo/repair it;
 * anything else — or no event at all — means a moderator did, or that nothing proves
 * otherwise, and the owner must not be handed the affordance.
 *
 * 🔴 ONE SPELLING OF THE PREDICATE, deliberately. `republishOwnListing`'s go-live guard
 * open-coded it first; the author EDIT paths in `offsite-listing.service` needed the same
 * question answered and would have open-coded it a second (third, fourth) time. A
 * predicate duplicated across call sites is wrong at all but one of them eventually, and
 * the direction it goes wrong here is "an owner may self-restore a listing a moderator
 * removed" — so it lives in exactly one place and every caller reads it from here.
 *
 * 🔴 FAIL-CLOSED ON ABSENCE. `null` (no events recorded) is NOT owner-unpublish. That is
 * the SAFE direction and it is a real branch, not a degenerate one: a listing removed
 * before the event table carried these actions, or a row whose events were pruned, must
 * be treated as a moderator removal rather than trusted to the owner.
 */

/**
 * The single action name an owner is allowed to act on. Every other verb is a moderator
 * (or system) action as far as any owner-facing capability is concerned.
 *
 * 🔴 Do NOT widen this to a set. The value space is the point — see
 * `normalizeLastModerationAction` in `app-access.service`, which collapses everything
 * else to `'other'` before it leaves the server precisely so a seated editor never
 * receives the moderator's actual verb.
 */
export const OWNER_UNPUBLISH_EVENT = 'owner-unpublish';

/**
 * The narrowest client shape this module needs.
 *
 * `Pick<Prisma.TransactionClient, …>` rather than the whole client so BOTH an in-tx `tx`
 * and a bare `dbRead`/`dbWrite` satisfy it — the moderation path must run inside its
 * transaction (see below), the author read paths must not open one.
 */
export type ModerationEventReader = Pick<Prisma.TransactionClient, 'appListingModerationEvent'>;

/**
 * The listing's most-recent moderation action, or `null` when it has none.
 *
 * 🔴 THE ORDERING IS `createdAt desc, id desc` AND BOTH KEYS MATTER. `createdAt` alone is
 * not a total order — two events written in the same transaction can share a timestamp,
 * and the id tiebreak (ULID-ish, monotonic) is what makes "most recent" deterministic
 * rather than whichever row the planner happened to return first. A non-deterministic
 * answer here flips an owner capability on and off at random.
 *
 * 🔴 WHICH POOL TO PASS IS THE CALLER'S DECISION, AND IT IS A SAFETY DECISION. Pass the
 * PRIMARY (`dbWrite`, or the in-tx `tx`): a moderator's `delist` event is written to the
 * primary, so a lagging replica can still show the owner's older `owner-unpublish` as
 * "most recent" and hand the owner a capability the moderator has just revoked. Reading
 * the primary can only err toward refusing, which is the direction that is safe. These
 * are author edit paths — a handful of calls per editing session, not a hot read.
 */
export async function readLastModerationAction(
  db: ModerationEventReader,
  appListingId: string
): Promise<string | null> {
  const lastEvent = await db.appListingModerationEvent.findFirst({
    where: { appListingId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { action: true },
  });
  return lastEvent?.action ?? null;
}

/**
 * Was the listing's last recorded moderation action the OWNER's own unpublish?
 *
 * Pure + exported so the branch (including the `null` arm) is unit-testable without a DB,
 * and so a caller that already holds the last action does not re-read it.
 */
export function isOwnerUnpublishAction(action: string | null | undefined): boolean {
  return action === OWNER_UNPUBLISH_EVENT;
}

/**
 * Convenience composition of the two above: read the last action on `db` and answer the
 * question. See {@link readLastModerationAction} for which pool to pass.
 */
export async function isOwnerUnpublishedListing(
  db: ModerationEventReader,
  appListingId: string
): Promise<boolean> {
  return isOwnerUnpublishAction(await readLastModerationAction(db, appListingId));
}
