import { dbWrite } from '~/server/db/client';
import { BlockRevocation } from '~/server/services/block-revocation.service';

/**
 * How many `revokeInstance` writes are in flight at once. Each is a single Redis
 * `SET` with an `EX`, so the ceiling exists to stop a publisher with a large
 * install base issuing one unbounded fan-out at ban time, not because the writes
 * are individually expensive.
 */
const REVOKE_CONCURRENCY = 100;

/**
 * THE THIRD `revokeInstance` WRITER, AND THE ONLY ONE WHOSE PURPOSE IS REVOCATION.
 *
 * The other two (`uninstallFromModel`, `toggleEnabled(false)`, both in
 * `block-registry.service.ts`) write a marker as a side effect of a different
 * operation. This one is called from `toggleBan` (`user.service.ts`) and exists so a
 * ban reaches the tokens a publisher's blocks are ALREADY holding, rather than only
 * the ones they would mint next.
 *
 * WHAT IT CLOSES, STATED NARROWLY. A ban already unpublishes the user's models,
 * cancels the subscription, blocks their media and invalidates their sessions. What
 * it did NOT do is write any of the three markers the runtime guards read
 * (`block-scope.middleware.ts` for REST, `block-bridge-auth.service.ts` for tRPC),
 * so every block token minted before the ban kept authenticating until its natural
 * `exp` — 900s by default, 14400s for a `dev` token
 * (`block-token-lifetimes.ts`). That residual, and only that residual, is what this
 * writer removes.
 *
 * 🔴 OWNERSHIP IS `app.userId` — THE OWNER, NOT A COLLABORATOR, AND THAT IS
 * DELIBERATE. An app block can carry seated collaborators (see `getMyApps` in
 * `blocks.router.ts` and `app-collaborator-earnings.service.ts`). Widening this
 * filter to "any app this user can reach" would let a ban on a collaborator revoke
 * every live token of an app owned by somebody who was not banned — a moderation
 * action against one account taking down another account's product. Banning the
 * OWNER is the case this closes; a seated collaborator is not a publisher.
 *
 * 🔴 NO `enabled` FILTER, ALSO DELIBERATE. A disabled install has a marker from
 * `toggleEnabled(false)` — but that marker is TTL-bound to one token lifetime and
 * may since have lapsed, and a row can be re-enabled. Re-marking an instance that is
 * already marked costs one Redis `SET` and can only narrow exposure, so the wider
 * set is the safe direction here.
 *
 * Reads the PRIMARY. The ban's own `bannedAt` write has already landed there, and an
 * install created seconds before the ban is exactly the row replica lag would hide.
 *
 * Never throws: `revokeInstance` swallows its own Redis errors by construction (a
 * Redis incident must not be able to fail a ban), and the caller additionally
 * isolates the DB read. Returns the number of instances it marked so the caller can
 * log it — a silent zero and a genuine zero are otherwise the same observation.
 */
export async function revokeBlockInstancesForPublisher({
  userId,
}: {
  userId: number;
}): Promise<number> {
  const rows = (await dbWrite.blockUserSubscription.findMany({
    where: {
      // A NULL `blockInstanceId` is a blanket subscription, which synthesises its id
      // on read and has no minted token keyed to a stored one.
      blockInstanceId: { not: null },
      appBlock: { app: { userId } },
    },
    select: { blockInstanceId: true },
  })) as Array<{ blockInstanceId: string | null }>;

  const instanceIds = rows
    .map((r) => r.blockInstanceId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  for (let i = 0; i < instanceIds.length; i += REVOKE_CONCURRENCY) {
    const chunk = instanceIds.slice(i, i + REVOKE_CONCURRENCY);
    await Promise.all(chunk.map((id) => BlockRevocation.revokeInstance(id)));
  }

  return instanceIds.length;
}
