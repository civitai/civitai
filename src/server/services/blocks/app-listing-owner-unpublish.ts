import type { Prisma } from '@prisma/client';

import type { AppListingModerationAction } from '~/server/schema/blocks/offsite-moderation.schema';

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
 * The moderation actions that WRITE `app_listings.status`, i.e. the only ones that can
 * explain why a listing is `removed`.
 *
 * 🔴 WHY THIS SET EXISTS: `AppListingModerationEvent` IS NOT A STATE LOG. It is a
 * moderator ACTIVITY log, and several of its actions change no listing status at all —
 * `message-owner` (a moderator writes to the owner), `report-resolve` / `report-dismiss`
 * (a REPORT's status flips, not the listing's) and `claim` (the listing's `userId` moves).
 * Reading "the last event of ANY kind" therefore answers a different question from the one
 * the callers below ask, and it answers it WRONG in the direction that hurts most: a
 * moderator who messages an owner *"fix X and republish"* — the single most natural
 * workflow this feature has — would push `message-owner` in front of the owner's own
 * `owner-unpublish`, silently REVOKING the repair loop and re-showing the owner the false
 * "removed by a moderator" attribution this module exists to delete.
 *
 * 🔴 THIS CODEBASE HAS ALREADY BEEN BITTEN BY EXACTLY THIS. See the comment on
 * `closeTerminalListing` in `offsite-listing.service`: a most-recent-event probe there was
 * defeated by an intervening `report-resolve`, in the UNSAFE direction (it let an owner
 * self-restore mod-mandated content). Same mechanism, opposite blast direction — which is
 * why the set is filtered in the QUERY rather than by post-hoc inspection of one row.
 *
 * 🔴 ADDING A NEW ACTION TO THE TAXONOMY MUST NOT SILENTLY CHANGE AUTHORIZATION — AND THE
 * DEFAULT IS NOT SAFE IN EITHER DIRECTION, WHICH IS WHY IT IS GATED RATHER THAN CHOSEN.
 * Omitting a new verb from this list makes it invisible to the WHERE clause below, so a
 * newer event of that verb does NOT displace an older `owner-unpublish` underneath it. For
 * a state-NEUTRAL verb (`message-owner`) that is exactly right. For a new status-CHANGING
 * takedown verb it is FAIL-OPEN: a moderator takes the listing down, the owner's stale
 * `owner-unpublish` resurfaces as "the most recent status-changing event", and the owner
 * regains edit AND `republishOwnListing` on content a moderator just removed.
 *
 * So the decision is forced to be made OUT LOUD rather than defaulted: both halves of the
 * partition are HARDCODED LITERALS (`STATE_NEUTRAL_MODERATION_ACTIONS` is NOT derived from
 * this one), `UnclassifiedModerationAction` below fails `pnpm typecheck` on any unclassified
 * verb, and `app-listing-owner-unpublish.test.ts` asserts the union equals
 * `APP_LISTING_MODERATION_ACTIONS` exactly. 🔴 Do NOT "simplify" either literal into
 * `APP_LISTING_MODERATION_ACTIONS.filter(…)` — a derived complement makes every partition
 * assertion a tautology that a new verb satisfies automatically, which is the precise shape
 * that restores the fail-open default above while leaving the suite green. (Measured: with
 * the neutral half derived, adding `'suspend'` to the taxonomy left 33/33 passing.)
 *
 * `purge` is included even though it hard-DELETES the row (its event's `appListingId` is
 * SetNull'd, so it can never come back from this query): the set is defined by what an
 * action MEANS, not by what happens to be reachable today.
 */
export const LISTING_STATUS_CHANGING_MODERATION_ACTIONS = [
  'delist',
  'relist',
  'purge',
  'reset-to-pending',
  'owner-unpublish',
  'owner-republish',
] as const satisfies readonly AppListingModerationAction[];

/**
 * The other half of the partition — actions recorded against a listing that leave
 * `app_listings.status` alone, and so must never displace the event that explains a
 * removal. Exported so the partition can be asserted as EXHAUSTIVE against the taxonomy.
 *
 * 🔴 THIS IS A HARDCODED LITERAL ON PURPOSE, NOT
 * `APP_LISTING_MODERATION_ACTIONS.filter(a => !CHANGING.includes(a))`. It was that derived
 * complement for one round, and the consequence was that EVERY partition assertion —
 * union-equals-taxonomy, empty intersection, size-sum — became a TAUTOLOGY satisfied by
 * construction: a new verb flowed into this set automatically and the whole suite stayed
 * green (measured: adding `'suspend'` to the taxonomy → 33 passed, 0 failed). The guard read
 * as coverage and provided none. Written out, a new verb is in NEITHER literal, the union
 * assertion fails, and the fail-open hazard described on
 * {@link LISTING_STATUS_CHANGING_MODERATION_ACTIONS} cannot be introduced by omission.
 *
 * The `satisfies` clause pins membership in the taxonomy; EXHAUSTIVENESS of the two halves
 * together is what `UnclassifiedModerationAction` and the partition test exist for.
 */
export const STATE_NEUTRAL_MODERATION_ACTIONS = [
  'claim',
  'report-resolve',
  'report-dismiss',
  'message-owner',
] as const satisfies readonly AppListingModerationAction[];

/**
 * A moderation action that is in the taxonomy but in NEITHER half of the partition above.
 * `never` while the classification is complete.
 *
 * 🔴 THE COMPILE-TIME HALF OF THE SAME GATE, and it is here because a test can be skipped,
 * excluded by a `-t` selector, or simply not run in whichever tier happened to go green.
 * `typecheck` cannot be. The assignment below is the gate: while this type is `never` it is
 * legal; the moment a verb joins {@link AppListingModerationAction} without being
 * classified, the type widens to that verb and `pnpm typecheck` fails ON THIS LINE, naming
 * it. The runtime partition test says the same thing a second time — two independent
 * readings of one invariant, on purpose.
 */
export type UnclassifiedModerationAction = Exclude<
  AppListingModerationAction,
  | (typeof LISTING_STATUS_CHANGING_MODERATION_ACTIONS)[number]
  | (typeof STATE_NEUTRAL_MODERATION_ACTIONS)[number]
>;
const _everyModerationActionIsClassified: never =
  undefined as unknown as UnclassifiedModerationAction;
void _everyModerationActionIsClassified;

/**
 * The narrowest client shape this module needs.
 *
 * `Pick<Prisma.TransactionClient, …>` rather than the whole client so BOTH an in-tx `tx`
 * and a bare `dbRead`/`dbWrite` satisfy it — the moderation path must run inside its
 * transaction (see below), the author read paths must not open one.
 */
export type ModerationEventReader = Pick<Prisma.TransactionClient, 'appListingModerationEvent'>;

/**
 * The listing's most-recent STATUS-CHANGING moderation action, or `null` when it has none.
 *
 * 🔴 IT IS FILTERED, NOT "THE LAST EVENT" — see
 * {@link LISTING_STATUS_CHANGING_MODERATION_ACTIONS}. A `message-owner`,
 * `report-resolve`/`report-dismiss` or `claim` row records moderator activity without
 * touching `app_listings.status`, so it cannot explain a removal and must not displace the
 * event that can. The filter is in the WHERE clause rather than applied to a fetched row:
 * "the newest of the interesting kind" is not derivable from "the newest of any kind".
 *
 * 🔴 THE ORDERING IS `createdAt desc, id desc` AND BOTH KEYS MATTER. `createdAt` alone is
 * not a total order — two events written in the same transaction can share a timestamp —
 * so the id tiebreak is what makes this deterministic rather than whichever row the planner
 * happened to return first. A non-deterministic answer here flips an owner capability on
 * and off at random. NOTE the tiebreak buys DETERMINISM, not correctness: these ids are
 * ULID-derived and so are monotonic only within one generating process, so for two events
 * that genuinely share a `createdAt` across processes the id order is stable but arbitrary.
 * That is enough here — every same-timestamp pair this query can see comes from one
 * transaction in one process.
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
    where: {
      appListingId,
      action: { in: [...LISTING_STATUS_CHANGING_MODERATION_ACTIONS] },
    },
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
