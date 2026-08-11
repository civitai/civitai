import { constants } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  AppCollaboratorError,
  recordOwnershipEvent,
} from '~/server/services/blocks/app-collaborator.service';
import { notifyAppCollaborator } from '~/server/services/blocks/app-collaborator-notify';
import { grantAppRepoWrite, revokeAppRepoWrite } from '~/server/services/blocks/app-repo-access';
import { newAppOwnershipTransferId } from '~/server/utils/app-block-ids';

/**
 * App Listing COLLABORATORS — OWNERSHIP TRANSFER (owner initiates → recipient accepts).
 *
 * ## Authorization: no moderator in the loop
 *
 * The prior art, `offsite-moderation.service.ts::claimListing:623`, is MOD-ONLY,
 * OFFSITE-ONLY and reassigns `AppListing.userId` alone. That guard SHAPE is extended
 * here (status-guarded `updateMany`, in-tx primary snapshot, an audit event written in
 * the same transaction so a rolled-back transfer leaves ZERO events, submission
 * history untouched), but the authorization model is different by product decision:
 * the owner initiates and the recipient accepts. Nobody else is involved.
 *
 * 🔴 And `claimListing`'s single write is INSUFFICIENT for an ONSITE app. Ownership is
 * canonically `OauthClient.userId` (`AppBlock.app.userId`); `AppListing.userId` is a
 * DENORMALIZED COPY. Moving only the listing column would leave the app's real owner
 * unchanged — the old owner would keep `getMyAppRepo`/`updateManifest`/`getMyApps`
 * while the new owner got the store listing. So accept writes BOTH columns in ONE
 * transaction. `app-ownership-transfer.service.test.ts` injects a failure on the second
 * write and asserts a full rollback.
 *
 * ## What deliberately does NOT move
 *
 *   - `AppBlockPublishRequest.submittedByUserId` — historical submission record,
 *     preserved for audit fidelity. Same locked decision as `claimListing`.
 *   - 🔴 `BlockBuzzAttribution.appOwnerUserId` — NOT rewritten. Product decision: Buzz
 *     accrued before the transfer stays with the OLD owner; the transfer is a clean
 *     forward cut. This is also what keeps the money invariant safe: those rows are
 *     grouped by `appOwnerUserId` in `bulk-payout-block-attributions.ts` and
 *     `mintPayoutForOwner` carries a `(app_owner_user_id, period_key)` UNIQUE.
 *     Rewriting the column mid-period would MERGE the two owners' pending rows into
 *     one payout group and could collide on that unique. Leaving them alone means the
 *     old owner is still paid for what they accrued and the new owner starts at zero.
 *     `app-ownership-transfer.service.test.ts`'s "MONEY INVARIANCE" describe pins this
 *     (including the positive control that proves those mocks CAN record a call).
 *
 * ## Forgejo
 *
 * On accept: revoke the OLD owner's repo write, grant the NEW owner's. Collaborator
 * seats are untouched by a transfer — the app keeps its editors.
 */

export type TransferView = {
  id: string;
  appBlockId: string;
  fromUserId: number;
  toUserId: number;
  status: string;
  expiresAt: Date;
  createdAt: Date;
};

/**
 * A pending transfer that has passed `expiresAt` is treated as ABSENT everywhere.
 *
 * Enforced as a READ-TIME predicate rather than by a sweeper job, so expiry is correct
 * with no cron dependency: an expired row can never be accepted, and `initiateTransfer`
 * reclaims it. A sweeper would only tidy rows.
 */
function isLive(t: { status: string; expiresAt: Date }, now: Date): boolean {
  return t.status === 'pending' && t.expiresAt.getTime() > now.getTime();
}

async function loadOwnedApp(
  appBlockId: string,
  actorUserId: number
): Promise<{ appBlockId: string; appId: string; slug: string; ownerUserId: number }> {
  const block = await dbRead.appBlock.findUnique({
    where: { id: appBlockId },
    select: { id: true, appId: true, blockId: true, app: { select: { userId: true } } },
  });
  if (!block?.app) throw new AppCollaboratorError('NOT_FOUND', 'App not found');
  if (block.app.userId !== actorUserId) {
    throw new AppCollaboratorError('NOT_OWNER', 'Only the app owner can transfer ownership');
  }
  return {
    appBlockId: block.id,
    appId: block.appId,
    slug: block.blockId,
    ownerUserId: block.app.userId,
  };
}

/**
 * OWNER: offer ownership to another user. Creates a `pending` transfer; NOTHING moves
 * until the recipient accepts.
 *
 * 🔴 A PENDING TRANSFER CONFERS ZERO CAPABILITY on the recipient — it is not a seat,
 * it does not appear in `resolveAppAccess`, and it grants no repo access. Same consent
 * principle as a pending invite.
 *
 * One in-flight transfer per app, enforced by the migration's PARTIAL UNIQUE index
 * (`app_block_id WHERE status='pending'`), which Prisma cannot express. A concurrent
 * second initiate loses on P2002 and is surfaced as a friendly error rather than a
 * raw constraint violation.
 */
export async function initiateTransfer(opts: {
  appBlockId: string;
  toUserId: number;
  actorUserId: number;
  now?: Date;
}): Promise<TransferView> {
  const now = opts.now ?? new Date();
  const app = await loadOwnedApp(opts.appBlockId, opts.actorUserId);

  if (opts.toUserId === app.ownerUserId) {
    throw new AppCollaboratorError('INVALID_TARGET', 'You already own this app');
  }
  const target = await dbRead.user.findUnique({
    where: { id: opts.toUserId },
    select: { id: true, bannedAt: true },
  });
  if (!target) throw new AppCollaboratorError('INVALID_TARGET', 'That user could not be found');
  if (target.bannedAt) {
    throw new AppCollaboratorError('BANNED', 'That account cannot receive app ownership');
  }

  // Reclaim an EXPIRED pending row first — otherwise the partial unique index would
  // block every future transfer for this app once one invitation lapsed.
  await dbWrite.appOwnershipTransfer.updateMany({
    where: { appBlockId: app.appBlockId, status: 'pending', expiresAt: { lte: now } },
    data: { status: 'expired', respondedAt: now },
  });

  const id = newAppOwnershipTransferId();
  const expiresAt = new Date(
    now.getTime() + constants.appCollaborators.transferExpiryDays * 86_400_000
  );

  let created: TransferView;
  try {
    created = await dbWrite.$transaction(async (tx) => {
      const row = (await tx.appOwnershipTransfer.create({
        data: {
          id,
          appBlockId: app.appBlockId,
          fromUserId: app.ownerUserId,
          toUserId: opts.toUserId,
          status: 'pending',
          expiresAt,
        },
        select: {
          id: true,
          appBlockId: true,
          fromUserId: true,
          toUserId: true,
          status: true,
          expiresAt: true,
          createdAt: true,
        },
      })) as TransferView;
      await recordOwnershipEvent(tx, {
        appBlockId: app.appBlockId,
        slug: app.slug,
        action: 'transfer_initiated',
        actorUserId: opts.actorUserId,
        targetUserId: opts.toUserId,
        metadata: { transferId: id, expiresAt: expiresAt.toISOString() },
      });
      return row;
    });
  } catch (err) {
    // The partial-unique index rejected a second live transfer. Duck-type on `code`
    // (the Prisma error class is not reliably constructible against a stale client) —
    // the same technique `beginListingRevision` uses for its one-shadow index.
    if ((err as { code?: unknown })?.code === 'P2002') {
      throw new AppCollaboratorError(
        'ALREADY_SEATED',
        'This app already has a pending ownership transfer. Cancel it first.'
      );
    }
    throw err;
  }

  try {
    await notifyAppCollaborator({
      type: 'app-ownership-transfer-offered',
      userId: opts.toUserId,
      key: `app-ownership-transfer-offered:${id}`,
      details: { slug: app.slug, appBlockId: app.appBlockId },
    });
  } catch {
    /* best-effort, post-commit */
  }
  return created;
}

/**
 * RECIPIENT: accept a pending ownership transfer.
 *
 * 🔴 THE ATOMIC CORE. In ONE transaction:
 *   1. re-read the transfer on the PRIMARY and re-assert it is live + addressed to the
 *      caller (a replica read could accept an already-cancelled offer under lag);
 *   1b. re-read the RECIPIENT's `bannedAt` on the PRIMARY. The ban was checked at
 *      INITIATE and again from `ctx.user` at the proc, but a transfer stays open for
 *      `transferExpiryDays` and a SESSION can be arbitrarily stale — so without this
 *      read the stated policy ("a banned user may not receive an ownership transfer")
 *      is simply false anywhere inside that window. `respondToInvite` re-reads the user
 *      row for exactly this reason; this one goes further and reads in-transaction on
 *      the primary, because unlike a seat an ownership move is not cheap to unwind;
 *   2. re-assert `OauthClient.userId` STILL equals the transfer's `fromUserId` — a
 *      status-guarded `updateMany` whose 0-count means the owner changed since the
 *      offer (a second transfer landed first), rolling everything back;
 *   3. move `AppListing.userId` for the backing listing — the denormalized copy;
 *   4. flip the transfer to `accepted`;
 *   5. write the audit event.
 *
 * Steps 2 and 3 are the two ownership columns; a failure in either rolls back BOTH.
 * That is asserted directly (inject a throw on the second write; assert the first is
 * not observable).
 *
 * NOT touched, by design: `AppBlockPublishRequest.submittedByUserId`,
 * `BlockBuzzAttribution.appOwnerUserId`, collaborator seats. See the module header.
 */
export async function acceptTransfer(opts: {
  transferId: string;
  userId: number;
  now?: Date;
}): Promise<{ transferId: string; appBlockId: string; fromUserId: number; toUserId: number }> {
  const now = opts.now ?? new Date();

  const result = await dbWrite.$transaction(async (tx) => {
    const transfer = (await tx.appOwnershipTransfer.findUnique({
      where: { id: opts.transferId },
      select: {
        id: true,
        appBlockId: true,
        fromUserId: true,
        toUserId: true,
        status: true,
        expiresAt: true,
        appBlock: { select: { appId: true, blockId: true } },
      },
    })) as (TransferView & { appBlock: { appId: string; blockId: string } | null }) | null;

    if (!transfer || !transfer.appBlock) {
      throw new AppCollaboratorError('NOT_FOUND', 'That ownership transfer no longer exists');
    }
    if (transfer.toUserId !== opts.userId) {
      throw new AppCollaboratorError('NOT_OWNER', 'This transfer was not offered to you');
    }
    if (!isLive(transfer, now)) {
      throw new AppCollaboratorError('NO_INVITE', 'This ownership transfer is no longer available');
    }

    // (1b) 🔴 RE-READ THE BAN on the primary, in-transaction. `ctx.user.bannedAt` is a
    // SESSION value and the offer may have been sitting open for days; the initiate-time
    // check says nothing about now. Without this, "a banned user may not receive an
    // ownership transfer" is false for the whole expiry window.
    const recipient = (await tx.user.findUnique({
      where: { id: opts.userId },
      select: { bannedAt: true },
    })) as { bannedAt: Date | null } | null;
    if (recipient?.bannedAt) {
      throw new AppCollaboratorError('BANNED', 'That account cannot receive app ownership');
    }

    // (2) CANONICAL owner column, status-guarded on the snapshotted previous owner.
    const movedClient = await tx.oauthClient.updateMany({
      where: { id: transfer.appBlock.appId, userId: transfer.fromUserId },
      data: { userId: transfer.toUserId },
    });
    if (movedClient.count === 0) {
      throw new AppCollaboratorError(
        'NO_INVITE',
        'Ownership of this app has changed; this transfer can no longer be accepted'
      );
    }

    // (3) DENORMALIZED copy. `updateMany` (not `update`) because an app need not have a
    // listing yet — a first-version app pending approval has no `AppListing` row. A
    // 0-count is therefore LEGITIMATE here and must not fail the transfer, which is
    // exactly why this is not status-guarded the way (2) is.
    await tx.appListing.updateMany({
      where: { appBlockId: transfer.appBlockId },
      data: { userId: transfer.toUserId },
    });

    // (4) Close the transfer, guarded so a concurrent cancel cannot be overwritten.
    const closed = await tx.appOwnershipTransfer.updateMany({
      where: { id: transfer.id, status: 'pending' },
      data: { status: 'accepted', respondedAt: now },
    });
    if (closed.count === 0) {
      throw new AppCollaboratorError('NO_INVITE', 'This ownership transfer is no longer available');
    }

    // (5) Audit — in-tx, so a rollback leaves ZERO events.
    await recordOwnershipEvent(tx, {
      appBlockId: transfer.appBlockId,
      slug: transfer.appBlock.blockId,
      action: 'transfer_accepted',
      actorUserId: opts.userId,
      targetUserId: opts.userId,
      metadata: {
        transferId: transfer.id,
        before: { userId: transfer.fromUserId },
        after: { userId: transfer.toUserId },
      },
    });

    return {
      transferId: transfer.id,
      appBlockId: transfer.appBlockId,
      fromUserId: transfer.fromUserId,
      toUserId: transfer.toUserId,
      slug: transfer.appBlock.blockId,
    };
  });

  // POST-COMMIT external effects. Swap the repo grants: the old owner loses write, the
  // new owner gains it. Collaborator seats are unaffected — the app keeps its editors.
  await revokeAppRepoWrite({ slug: result.slug, userId: result.fromUserId });
  await grantAppRepoWrite({ slug: result.slug, userId: result.toUserId });

  try {
    await notifyAppCollaborator({
      type: 'app-ownership-transfer-accepted',
      userId: result.fromUserId,
      key: `app-ownership-transfer-accepted:${result.transferId}`,
      details: { slug: result.slug, appBlockId: result.appBlockId },
    });
  } catch {
    /* best-effort, post-commit */
  }

  return {
    transferId: result.transferId,
    appBlockId: result.appBlockId,
    fromUserId: result.fromUserId,
    toUserId: result.toUserId,
  };
}

/**
 * Cancel a pending transfer. Either party may: the OWNER withdraws the offer, or the
 * RECIPIENT declines it. Both land on the same terminal state and the same audit
 * action — the actor id on the event records which of the two it was.
 */
export async function cancelTransfer(opts: {
  transferId: string;
  actorUserId: number;
  now?: Date;
}): Promise<{ transferId: string; cancelled: boolean }> {
  const now = opts.now ?? new Date();

  return dbWrite.$transaction(async (tx) => {
    const transfer = (await tx.appOwnershipTransfer.findUnique({
      where: { id: opts.transferId },
      select: {
        id: true,
        appBlockId: true,
        fromUserId: true,
        toUserId: true,
        status: true,
        expiresAt: true,
        appBlock: { select: { blockId: true } },
      },
    })) as (TransferView & { appBlock: { blockId: string } | null }) | null;

    if (!transfer || !transfer.appBlock) {
      throw new AppCollaboratorError('NOT_FOUND', 'That ownership transfer no longer exists');
    }
    if (transfer.fromUserId !== opts.actorUserId && transfer.toUserId !== opts.actorUserId) {
      throw new AppCollaboratorError('NOT_OWNER', 'You are not party to this transfer');
    }

    const closed = await tx.appOwnershipTransfer.updateMany({
      where: { id: transfer.id, status: 'pending' },
      data: { status: 'cancelled', respondedAt: now },
    });
    if (closed.count === 0) return { transferId: transfer.id, cancelled: false };

    await recordOwnershipEvent(tx, {
      appBlockId: transfer.appBlockId,
      slug: transfer.appBlock.blockId,
      action: 'transfer_cancelled',
      actorUserId: opts.actorUserId,
      targetUserId: transfer.toUserId,
      metadata: { transferId: transfer.id },
    });
    return { transferId: transfer.id, cancelled: true };
  });
}

/**
 * The LIVE pending transfer for an app, or `null`. Expiry is applied as a read-time
 * predicate (see {@link isLive}) so an expired row never surfaces as pending, whether
 * or not anything has swept it.
 *
 * 🔴 AUTHORIZED, like its three siblings. The row names BOTH parties (`fromUserId`,
 * `toUserId`) and the offer's deadline; every other transfer proc gates
 * (`initiateTransfer` → owner, `acceptTransfer` → addressee, `cancelTransfer` → either
 * party), and this one took no caller at all, so any flagged account could read who is
 * handing which app to whom. Permitted: the app OWNER (who is the offer's `fromUserId`)
 * and the ADDRESSEE, matching exactly the set that may act on the transfer.
 *
 * An unauthorized caller gets `null`, NOT a FORBIDDEN. Throwing would make this proc an
 * existence ORACLE — "this app has a pending transfer" is itself the private fact — so
 * the refusal is made indistinguishable from "there is no offer". (`NOT_FOUND` for a
 * missing app is fine: app existence is already public.)
 */
export async function getPendingTransfer(opts: {
  appBlockId: string;
  /** The caller. Required — this is not a public read; see above. */
  viewerUserId: number;
  now?: Date;
}): Promise<TransferView | null> {
  const now = opts.now ?? new Date();
  const { resolveAppAccess } = await import('~/server/services/blocks/app-access.service');
  const access = await resolveAppAccess(opts.appBlockId, opts.viewerUserId);
  if (!access) throw new AppCollaboratorError('NOT_FOUND', 'App not found');
  const row = (await dbRead.appOwnershipTransfer.findFirst({
    where: { appBlockId: opts.appBlockId, status: 'pending' },
    select: {
      id: true,
      appBlockId: true,
      fromUserId: true,
      toUserId: true,
      status: true,
      expiresAt: true,
      createdAt: true,
    },
  })) as TransferView | null;
  if (!row || !isLive(row, now)) return null;
  // Owner or addressee only. An EDITOR is deliberately excluded: a seat is a content
  // capability, and disposing of the app is the one thing an editor may not do or
  // initiate — so it is not theirs to watch either.
  if (access.role !== 'owner' && row.toUserId !== opts.viewerUserId) return null;
  return row;
}
