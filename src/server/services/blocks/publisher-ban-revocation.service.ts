import { dbWrite } from '~/server/db/client';
import { BlockRevocation } from '~/server/services/block-revocation.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

/**
 * How many marker writes stay in flight at once. Each is a single Redis `SET` with an
 * `EX`, so the ceiling exists to stop a publisher with a large install base issuing one
 * unbounded fan-out at ban time, not because the writes are individually expensive.
 *
 * ⚠️ Measured as INERT at today's volumes — the worst per-publisher fan-out is ~37 ids,
 * so this can never bind. Kept as a cheap bound on a set that grows per installing
 * viewer, not presented as load-bearing.
 */
const REVOKE_CONCURRENCY = 100;

/**
 * 🔴 A blockInstanceId IS NOT ALWAYS A STORED COLUMN, AND ASSUMING IT IS UNDER-REVOKES
 * BY FOUR NAMESPACES OUT OF FIVE. This function was first written as
 * `where: { blockInstanceId: { not: null } }`, justified by "a blanket subscription
 * has no minted token keyed to a stored one". The second half of that sentence is true
 * and IRRELEVANT: the token is keyed to the SYNTHESISED id, and the guards compare
 * `claims.blockInstanceId` verbatim, so a marker under the synthesised id works exactly
 * as well as one under a stored id.
 *
 * The namespaces, per `BlockRegistry.resolveBlockInstance` (the SERVER resolver the mint
 * dispatches on) and `deriveScopeFromInstanceId` (its client-side twin) — both pinned by
 * `publisher-ban-revocation.namespaces.test.ts`:
 *
 *   `bki_*` / `mbi_*`   stored in `BlockUserSubscription.blockInstanceId` (pinned install)
 *   `bus_pub_<busId>`   synthesised — blanket `publisher_all_my_models` subscription
 *   `bus_view_<busId>`  synthesised — `viewer_personal` subscription
 *   `pdb_<appBlockId>`  synthesised — platform-default promotion
 *   `page_<appBlockId>` synthesised — the approved `<slug>.civit.ai` full-page surface
 *
 * 🔴 AND `page_` HAS THREE MINT SHAPES, NOT ONE — the prefix hides them, which is why a
 * prefix-granular guard cannot see the gap. `block-tokens/index.ts` mints
 * `page_<appBlockId>` for an approved block; `dev-token.ts` additionally mints
 * `page_pubreq_<publishRequestId>` for a caller-owned PENDING submission and
 * `page_local_<slug>` for an unsubmitted local app. Both dev shapes are `dev: true`, so
 * they live 14400s — the widest exposure of any token here, on exactly the surface a
 * banned author is most likely to hold.
 *
 *   - `page_pubreq_*` IS covered: the publish request is a server row, keyed on
 *     `submittedByUserId`.
 *   - 🔴 `page_local_*` IS NOT COVERED AND CANNOT BE, and this is documented rather than
 *     papered over. That shape exists precisely BECAUSE there is no server row of any
 *     kind — no AppBlock, no publish request, nothing that ties the slug to a user — so
 *     there is no set to enumerate at ban time. Closing it needs a different mechanism
 *     (a per-user mint ledger, or keying dev revocation on the subject user rather than
 *     the instance), which is a design change, not a wider query. Until then a banned
 *     author's `page_local_*` dev token runs to its natural 4h `exp`.
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
 * "The app blocks `userId` canonically OWNS", as a Prisma predicate — the query form of
 * `resolveCanonicalListingOwner` (`app-access.service.ts`), branch for branch.
 *
 * 🔴 `app.userId` IS NOT THE OWNER FOR AN OFFSITE LISTING, AND THIS USED TO ASSUME IT
 * WAS. The canonical resolver returns `AppListing.userId` whenever the parent listing's
 * kind is not `onsite`, unconditionally, even when a block IS attached. `claimListing`
 * (`offsite-moderation.service.ts`) is the documented impersonation remedy — report →
 * delist → claim → ban — and it moves the LISTING column only, leaving
 * `OauthClient.userId` on the impersonator, with no requirement that `appBlockId` be
 * null. So the very sequence this control exists to serve produces a block whose
 * `app.userId` is the impersonator and whose canonical owner is the VICTIM: banning the
 * impersonator with an `app: { userId }` filter revoked the victim's live tokens.
 *
 * ⚠️ AND IT IS NOT ONLY A MODERATOR PATH. `acceptTransfer`
 * (`app-ownership-transfer.service.ts`) runs its `oauthClient.updateMany` only under
 * `if (isOnsite)` while writing the listing column for both kinds, so an ordinary,
 * user-driven offsite transfer leaves the same split behind.
 *
 * 🔴 THE DEFENCE THAT MADE KEYING ON `app.userId` LOOK SAFE IS FALSE. "Off-site apps
 * mint no block token" was never proven, and is disproven by enumeration:
 * `BlockTokenService.sign` has exactly two non-test call sites (`block-tokens/index.ts`,
 * `blocks/dev-scoped-mint.service.ts`), and NO mint path — nor `resolvePageBlock`, nor
 * `resolveBlockInstance` — reads `AppListing` or a listing `kind` at all. Mintability is
 * decided by `app_blocks.status` plus the flags; canonical ownership is decided by
 * columns the mint never looks at. The `page_<appBlockId>` mint needs no install row of
 * any kind. The migration header asserting "NO install, NO block token" for
 * external-link apps is a product INTENTION with no enforcing code.
 *
 * ⚠️ A PRODUCTION COUNT SAYS THIS SHAPE IS CURRENTLY EMPTY, AND THAT IS NOT A REASON TO
 * KEY ON `app.userId`. `app-access.service.ts` and `offsite-listing.service.ts` both
 * record "offsite 5 rows, 0 with a block", measured 2026-08-11, and both label it
 * *"empirical, not structural — do not restate it as 'never, ever'"*. Nothing here
 * re-measured it. A control keyed on a count that one approval can change is not keyed
 * on anything.
 *
 * The three branches ARE the resolver:
 *   1. no listing at all      → owner = `app.userId`  (`AppBlock.app` is a required
 *                               relation, so `blockOwnerUserId` is never null and the
 *                               resolver's `?? listingUserId` fallback is unreachable here)
 *   2. an `onsite` listing    → owner = `app.userId`
 *   3. a non-`onsite` listing → owner = `AppListing.userId`
 *
 * 🔴 BRANCH 1 IS LOAD-BEARING AND MUST NOT BE DROPPED. Most app blocks predate W13 and
 * have no listing row; selecting only via the listing would UNDER-revoke, which for a
 * security control is strictly worse than over-revoking — and it would look fine in any
 * fixture that bothered to create a listing. `AppListing.appBlockId` is `@unique` and
 * `beginListingRevision` writes the shadow with a NULL `appBlockId`, so a block has at
 * most one listing and a shadow can never hold it: `appBlock.appListing` is always the
 * PARENT, which is the row the resolver wants. That is why this needs no
 * `revisionOfId: null` clause, unlike `canonicalOwnerWhereBranches`, whose callers query
 * from the listing side.
 *
 * ⚠️ NOT VERIFIED AGAINST A REAL DATABASE. The branch LOGIC is pinned against
 * `resolveCanonicalListingOwner` by an executable equivalence test
 * (`publisher-ban-revocation.namespaces.test.ts`), but whether Prisma emits the
 * `NOT EXISTS` branch 1 needs for `appListing: { is: null }` on a to-one BACK-relation
 * has NOT been executed — every suite here mocks Prisma. If branch 1 silently matched
 * nothing, every listing-less block would go unrevoked and no test in this repo would
 * see it.
 */
export function canonicallyOwnedAppBlock(userId: number) {
  return {
    OR: [
      { app: { userId }, appListing: { is: null } },
      { app: { userId }, appListing: { is: { kind: 'onsite' } } },
      { appListing: { is: { kind: { not: 'onsite' }, userId } } },
    ],
  };
}

/**
 * Every blockInstanceId a ban on `userId` must reach. Shared by the ban writer and the
 * unban clearer so the two cannot enumerate different sets — the clear is only a remedy
 * if it addresses the same ids the ban marked.
 *
 * 🔴 OWNERSHIP IS THE CANONICAL OWNER, NOT A COLLABORATOR, AND THAT IS DELIBERATE.
 * An app block can carry seated collaborators (see `getMyApps` in `blocks.router.ts` and
 * `app-collaborator-earnings.service.ts`). Widening this to "any app this user can reach"
 * would let a ban on a collaborator revoke every live token of an app owned by somebody
 * who was not banned — a moderation action against one account taking down another
 * account's product. Banning the OWNER is the case this closes.
 *
 * 🔴 NO `enabled` FILTER, ALSO DELIBERATE. A disabled install has an INSTALL marker from
 * `toggleEnabled(false)` — but that marker is TTL-bound and may have lapsed, and the row
 * can be re-enabled. Re-marking costs one Redis `SET` and can only narrow exposure.
 *
 * `pdb_*` and `page_*` are emitted for EVERY owned app block rather than read back from
 * `PlatformDefaultBlock` / the manifest's slot list. One marker on a surface the block
 * does not expose refuses nothing and costs one `SET`, bounded by the number of apps the
 * user owns; a second read would add a table to get wrong and a race with a promotion
 * landing mid-ban. (`platform_default_blocks` currently holds 0 rows, so the `pdb_` leg
 * is inert today — kept because a promotion is a single insert away.)
 *
 * Reads the PRIMARY. The ban's own `bannedAt` write has already landed there, and an
 * install created seconds before the ban is exactly the row replica lag would hide.
 */
async function resolvePublisherInstanceIds(userId: number): Promise<string[]> {
  const [subscriptions, appBlocks, pendingRequests] = await Promise.all([
    dbWrite.blockUserSubscription.findMany({
      where: { appBlock: canonicallyOwnedAppBlock(userId) },
      select: { id: true, scope: true, blockInstanceId: true },
    }) as Promise<SubscriptionRow[]>,
    dbWrite.appBlock.findMany({
      where: canonicallyOwnedAppBlock(userId),
      select: { id: true },
    }) as Promise<Array<{ id: string }>>,
    // `page_pubreq_<id>` — the dev mint's PENDING-submission shape.
    //
    // 🔴 KEYED ON THE SUBMITTER, NOT THE CANONICAL OWNER, AND DELIBERATELY SO: it mirrors
    // the MINT. `dev-token.ts` will only issue this token to the row's own
    // `submittedByUserId`, so the submitter is the only account that can be holding one,
    // and there is no app block to resolve an owner from — a pending request may have no
    // `appBlockId` at all. Same distinction the gate ledger records for
    // `withdrawExternalRequest` (D3). The mint additionally filters on `slug`; we do not,
    // because here we want every pending submission this user holds.
    dbWrite.appBlockPublishRequest.findMany({
      where: { submittedByUserId: userId, status: 'pending' },
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
  for (const { id } of pendingRequests) {
    instanceIds.add(`page_pubreq_${id}`);
  }
  return [...instanceIds];
}

/**
 * THE BAN WRITER — the only production caller of `BlockRevocation.revokeInstanceForBan`.
 *
 * Called from `toggleBan` (`user.service.ts`) so a ban reaches the tokens a publisher's
 * blocks are ALREADY holding, rather than only the ones they would mint next.
 *
 * WHAT IT CLOSES, STATED NARROWLY. A ban already unpublishes the user's models, cancels
 * the subscription, blocks their media and invalidates their sessions. What it did NOT do
 * is write any of the markers the runtime guards read (`block-scope.middleware.ts` for
 * REST, `block-bridge-auth.service.ts` for tRPC), so every block token minted before the
 * ban kept authenticating until its natural `exp` — 900s by default, 14400s for a `dev`
 * token (`block-token-lifetimes.ts`). That residual, and only that residual, is what this
 * writer removes.
 *
 * 🔴 AND IT IS TIME-BOXED, NOT PERMANENT. The markers expire after
 * `MAX_BLOCK_TOKEN_LIFETIME_SECONDS`. Making a ban durable beyond that is clawgate #620
 * (flipping `app_blocks.status`), deliberately LAYERED with this rather than replacing
 * it: the status flip is read from the REPLICA and is therefore lag-delayed, while these
 * markers kill a live session at Redis speed. Do not remove this leg when #620 lands.
 *
 * Never throws: the marker writes swallow their own Redis errors by construction (a Redis
 * incident must not be able to fail a ban), and the caller additionally isolates the DB
 * reads. Returns the number of instance ids it marked so the caller can log it — a silent
 * zero and a genuine zero are otherwise the same observation.
 */
export async function revokeBlockInstancesForPublisher({
  userId,
}: {
  userId: number;
}): Promise<number> {
  const instanceIds = await resolvePublisherInstanceIds(userId);

  // `limitConcurrency` keeps N continuously in flight. A hand-rolled
  // `for (i += N) { await Promise.all(slice) }` is a BARRIER — every batch waits on
  // its slowest member — which is not what the ceiling above says it is.
  await limitConcurrency(
    instanceIds.map((id) => () => BlockRevocation.revokeInstanceForBan(id)),
    REVOKE_CONCURRENCY
  );

  return instanceIds.length;
}

/**
 * THE UNBAN CLEARER — the mirror of the writer above, and the remedy for a mis-ban.
 *
 * 🔴 IT EXISTS BECAUSE "re-minting is the recovery path" WAS FALSE, INCLUDING IN THIS
 * FILE. `isRevoked` keys on `claims.blockInstanceId`, and every namespace's id is STABLE
 * across a re-mint — `bki_*` is a stored column, and `bus_pub_*`, `bus_view_*`, `pdb_*`,
 * `page_*` and `page_pubreq_*` are all derived from row ids that a re-mint does not
 * change. So a freshly minted token carries exactly the id the marker names and is
 * refused identically. Without this, lifting a mistaken ban left the publisher's entire
 * block surface dead for up to MAX_BLOCK_TOKEN_LIFETIME_SECONDS (4h if any dev token is
 * involved) with no product-level remedy — a moderator would have had to delete Redis
 * keys by hand.
 *
 * 🔴 IT CLEARS THE BAN KEYSPACE ONLY. An INSTALL marker from a genuine uninstall or
 * toggle-off is a different key and survives untouched, so lifting a ban does not
 * silently re-enable an install its own consumer switched off.
 *
 * Best-effort by construction. It re-enumerates rather than replaying a recorded set, so
 * an instance that appeared or disappeared between the ban and the unban may be missed;
 * anything missed expires on its own within one token lifetime, which is the same bound
 * that applied before this function existed.
 */
export async function clearBlockInstancesForPublisher({
  userId,
}: {
  userId: number;
}): Promise<number> {
  const instanceIds = await resolvePublisherInstanceIds(userId);

  await limitConcurrency(
    instanceIds.map((id) => () => BlockRevocation.clearBanInstance(id)),
    REVOKE_CONCURRENCY
  );

  return instanceIds.length;
}
