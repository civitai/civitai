import { dbWrite } from '~/server/db/client';
import { BlockRevocation } from '~/server/services/block-revocation.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

/**
 * How many `revokeInstance` writes stay in flight at once. Each is a single Redis
 * `SET` with an `EX`, so the ceiling exists to stop a publisher with a large install
 * base issuing one unbounded fan-out at ban time, not because the writes are
 * individually expensive.
 */
const REVOKE_CONCURRENCY = 100;

/**
 * 🔴 A blockInstanceId IS NOT ALWAYS A STORED COLUMN, AND ASSUMING IT IS UNDER-REVOKES
 * BY FOUR NAMESPACES OUT OF FIVE. This function was first written as
 * `where: { blockInstanceId: { not: null } }`, justified by "a blanket subscription
 * synthesises its id on read, so it has no minted token keyed to a stored one". The
 * second half of that sentence is true and IRRELEVANT: the token is keyed to the
 * SYNTHESISED id, and the guards compare `claims.blockInstanceId` verbatim, so a
 * marker written under the synthesised id works exactly as well as one written under a
 * stored id. Excluding those rows silently left the publisher's own default install
 * shape running.
 *
 * The five namespaces, per `deriveScopeFromInstanceId`
 * (`~/server/schema/blocks/attribution.schema`), which is the canonical PARSER and the
 * thing `publisher-ban-revocation.namespaces.test.ts` pins this list against:
 *
 *   `bki_*` / `mbi_*`  stored in `BlockUserSubscription.blockInstanceId` (pinned install)
 *   `bus_pub_<busId>`  synthesised — blanket `publisher_all_my_models` subscription
 *   `bus_view_<busId>` synthesised — `viewer_personal` subscription
 *   `pdb_<appBlockId>` synthesised — platform-default promotion
 *   `page_<appBlockId>` synthesised — the `<slug>.civit.ai` full-page surface
 *
 * The last two hang off the APP BLOCK, not off any subscription row, so no query over
 * `BlockUserSubscription` alone can ever reach them.
 */
type SubscriptionRow = { id: string; scope: string; blockInstanceId: string | null };

/**
 * The instance id a subscription row's tokens actually carry. Mirrors the two
 * synthesising `SELECT`s in `BlockRegistry.listForModel` (`'bus_pub_' || bus.id`,
 * `'bus_view_' || bus.id`) and the prefixes `resolveBlockInstance` dispatches on.
 *
 * Returns null for a scope this function does not recognise rather than guessing a
 * prefix — a marker under a wrong id refuses nothing and would read as coverage. The
 * namespace guard test is what makes that null loud instead of silent.
 */
function subscriptionInstanceId(row: SubscriptionRow): string | null {
  if (typeof row.blockInstanceId === 'string' && row.blockInstanceId.length > 0) {
    return row.blockInstanceId;
  }
  if (row.scope === 'publisher_all_my_models') return `bus_pub_${row.id}`;
  if (row.scope === 'viewer_personal') return `bus_view_${row.id}`;
  return null;
}

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
 * 🔴 AND IT IS TIME-BOXED, NOT PERMANENT. The markers expire after
 * `MAX_BLOCK_TOKEN_LIFETIME_SECONDS`, and nothing downstream of them consults owner
 * ban state — not the mint (`block-tokens/index.ts` gates the REQUESTING user's ban,
 * never the app owner's), not the render, not `block-approval.service.ts` (a ban does
 * not flip `app_blocks.status`). So this contains a live session; it does not keep a
 * banned publisher's blocks off the platform, and no comment citing it should say
 * otherwise. Making the ban durable is a separate decision at the mint.
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
 * `pdb_*` and `page_*` are emitted for EVERY owned app block rather than read back
 * from `PlatformDefaultBlock` / the manifest's slot list. One marker on a surface the
 * block does not expose refuses nothing and costs one `SET`, bounded by the number of
 * apps the user owns; a second read would add a table to get wrong and a race with a
 * promotion landing mid-ban.
 *
 * Reads the PRIMARY. The ban's own `bannedAt` write has already landed there, and an
 * install created seconds before the ban is exactly the row replica lag would hide.
 *
 * Never throws: `revokeInstance` swallows its own Redis errors by construction (a
 * Redis incident must not be able to fail a ban), and the caller additionally
 * isolates the DB reads. Returns the number of instance ids it marked so the caller
 * can log it — a silent zero and a genuine zero are otherwise the same observation.
 */
export async function revokeBlockInstancesForPublisher({
  userId,
}: {
  userId: number;
}): Promise<number> {
  const [subscriptions, appBlocks] = await Promise.all([
    dbWrite.blockUserSubscription.findMany({
      where: { appBlock: { app: { userId } } },
      select: { id: true, scope: true, blockInstanceId: true },
    }) as Promise<SubscriptionRow[]>,
    dbWrite.appBlock.findMany({
      where: { app: { userId } },
      select: { id: true },
    }) as Promise<Array<{ id: string }>>,
  ]);

  // A set, because the same id cannot be reached twice today but nothing structural
  // stops a future source overlapping — and a duplicate would inflate the count this
  // function returns, which is the only number the ban logs.
  const instanceIds = new Set<string>();
  for (const row of subscriptions) {
    const id = subscriptionInstanceId(row);
    if (id) instanceIds.add(id);
  }
  for (const { id } of appBlocks) {
    instanceIds.add(`pdb_${id}`);
    instanceIds.add(`page_${id}`);
  }

  // `limitConcurrency` keeps N continuously in flight. A hand-rolled
  // `for (i += N) { await Promise.all(slice) }` is a BARRIER — every batch waits on
  // its slowest member — which is not what the ceiling above says it is.
  await limitConcurrency(
    [...instanceIds].map((id) => () => BlockRevocation.revokeInstance(id, { cause: 'ban' })),
    REVOKE_CONCURRENCY
  );

  return instanceIds.size;
}
