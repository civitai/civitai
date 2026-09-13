import { TRPCError } from '@trpc/server';
import { dbRead } from '~/server/db/client';
import {
  verifyBlockToken,
  type BlockTokenClaims,
} from '~/server/middleware/block-scope.middleware';
import { BlockRevocation } from '~/server/services/block-revocation.service';

/**
 * THE authorization gate for the tRPC half of the host↔block postMessage bridge
 * (`blocks.router.ts`). Every bridge procedure resolves its claims through here and
 * nowhere else.
 *
 * `verifyBlockToken` answers ONE question — is this a token we signed, for this
 * issuer/audience, not yet expired. It says nothing about whether the install still
 * exists or the app is still allowed to run, so on its own it keeps honouring a token
 * for a whole lifetime after the user uninstalled the app or a moderator suspended it.
 * The REST wrapper has always known this (`withBlockScope` → `BlockRevocation.isRevoked`),
 * and so do the two tRPC resolvers beside this one — `resolveStorageContext`
 * (apps.router) and `resolveSharedContext` (apps-shared.router). The bridge procs called
 * `verifyBlockToken` directly, thirteen times, and checked neither.
 *
 * ORDER, and why it is this order:
 *   1. TOKEN VALIDITY — nothing downstream can be trusted before it; an unverifiable
 *      token also has no `blockInstanceId` to key a revocation lookup on.
 *   2. REVOCATION — a Redis GET, so it is the cheap check and it runs before the DB
 *      read. It is also the one that responds to a user action (uninstall / toggle-off /
 *      publisher ban) within seconds rather than at the next approval change.
 *   3. APPROVED STATUS — the backing `app_blocks` row must still say `approved`.
 *
 * Each step fails closed EXCEPT revocation, which fails OPEN by construction inside
 * `BlockRevocation.isRevoked` (a Redis incident must not take the bridge down; exposure
 * is bounded by the token lifetime instead of by Redis recovery time — see that
 * service's own note). That is a property of the primitive, deliberately inherited here
 * rather than re-decided, so the REST and tRPC paths cannot drift apart on it.
 */
export async function authorizeBlockBridgeToken(blockToken: string): Promise<BlockTokenClaims> {
  const claims = await verifyBlockToken(blockToken);
  if (!claims) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'invalid block token' });

  // Per-instance revocation. Keyed on the token's OWN `blockInstanceId` claim, never on
  // anything the caller sent. Dev and review-sandbox tokens carry a synthetic but stable
  // instance id minted for exactly this purpose, so they are covered too.
  if (await BlockRevocation.isRevoked(claims.blockInstanceId)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'block instance revoked' });
  }

  await assertAppBlockApproved(claims);

  return claims;
}

/**
 * The backing `app_blocks` row must still be `approved`. Resolved by the same
 * `(appId, blockId)` unique the sibling resolvers use, and from the token's claims only.
 *
 * 🔴 THE ONE EXEMPTION — a `dev` token, and it is a documented product decision, not an
 * oversight. `/api/v1/block-tokens`'s `tryDevTunnelOwnedNonApprovedMint` mints a dev
 * token carrying the app's REAL ids for an app that is deliberately NOT approved: a
 * suspended / pending / deprecated app stays runnable by its OWNER inside the owner's own
 * dev tunnel, so they can diagnose it back into review. That path is contained by its own
 * belt — ownership enforced in the query, an ACTIVE dev tunnel required, author +
 * dev-tunnel flags, self-bound `sub`, forced-SFW, dev-budget-capped, and never public.
 * Enforcing approval here would break it. The dev-token mints that have no backing row at
 * all (the pending / local-manifest / review-sandbox paths, which sign a synthetic
 * `pubreq_…` / `page_local_…` / `ephemeral-…` appBlockId) are covered by the same
 * exemption for the same reason: there is no row to be approved.
 *
 * Revocation above is NOT exempted — every one of those mints stamps a revocable instance
 * id, so a dev token is still killable.
 */
async function assertAppBlockApproved(claims: BlockTokenClaims): Promise<void> {
  if (claims.dev === true) return;

  const block = await dbRead.appBlock.findUnique({
    where: { appId_blockId: { appId: claims.appId, blockId: claims.blockId } },
    select: { status: true },
  });
  if (!block) throw new TRPCError({ code: 'NOT_FOUND', message: 'app block not found' });
  if (block.status !== 'approved') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'app block is not approved' });
  }
}
