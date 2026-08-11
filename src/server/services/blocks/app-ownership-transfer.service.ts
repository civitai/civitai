import { constants } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import type { ListingKind } from '~/server/services/blocks/app-access.service';
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
 * 🔴 LISTING-KEYED, so it works for BOTH store kinds. See `app-access.service`'s header.
 *
 * ## Authorization: no moderator in the loop
 *
 * The prior art, `offsite-moderation.service.ts::claimListing`, is MOD-ONLY,
 * OFFSITE-ONLY and reassigns `AppListing.userId` alone. That guard SHAPE is extended
 * here (status-guarded `updateMany`, in-tx primary snapshot, an audit event written in
 * the same transaction so a rolled-back transfer leaves ZERO events, submission
 * history untouched), but the authorization model is different by product decision:
 * the owner initiates and the recipient accepts. Nobody else is involved.
 *
 * ## 🔴 HOW THIS RELATES TO `claimListing` — they cannot race or disagree
 *
 * Both paths write `AppListing.userId` on an off-site listing, so the relationship is
 * stated rather than assumed:
 *
 *   - DIFFERENT AUTHORITY. `claimListing` is a MODERATOR remedy (the impersonation
 *     workflow: report → delist → claim → ban) requiring a mod reason and gated on
 *     `status IN (approved, removed)`. This is an OWNER-initiated, recipient-consented
 *     hand-over. Neither is a substitute for the other and neither calls the other.
 *   - THEY CANNOT INTERLEAVE INTO A WRONG STATE. `acceptTransfer`'s off-site write is
 *     status-guarded on `userId = <the snapshotted fromUserId>`. So if a mod claims the
 *     listing after the offer was made, the accept matches 0 rows and is refused with
 *     "ownership has changed" — the pending offer becomes permanently unacceptable
 *     (fail-closed), rather than silently undoing the mod's remedy. In the other order,
 *     a mod claim over an already-accepted transfer simply wins, which is the intended
 *     precedence: moderator authority is final.
 *   - SEPARATE AUDIT TRAILS, both written. `claimListing` writes an
 *     `AppListingModerationEvent`; this writes an `AppOwnershipEvent`. Neither is
 *     derived from the other, so a listing whose owner moved twice shows both.
 *
 * 🔴 `claimListing`'s single write is INSUFFICIENT for an ONSITE listing. Ownership is
 * canonically `OauthClient.userId` (`AppBlock.app.userId`); `AppListing.userId` is a
 * DENORMALIZED COPY. Moving only the listing column would leave the app's real owner
 * unchanged — the old owner would keep `getMyAppRepo`/`updateManifest`/`getMyApps`
 * while the new owner got the store listing. So an ONSITE accept writes BOTH columns in
 * ONE transaction. `app-ownership-transfer.service.test.ts` injects a failure on the
 * second write and asserts a full rollback.
 *
 * ## 🔴 OFF-SITE + a linked OAuth client: REFUSED, at both ends
 *
 * v1 moves `AppListing.userId` and nothing else. An off-site listing may carry a
 * `connectClientId` — an `OauthClient` with a SECRET, redirect URIs and allowed
 * origins. Moving those is a materially different act from handing over a store
 * listing, and both silent options are bad:
 *   - silently moving the client hands over live credentials the recipient never asked
 *     for and the initiator may not have meant to include; and
 *   - silently NOT moving it leaves ownership SPLIT — the listing says one user, the
 *     credential says another — which is the state that produces "why can't I rotate my
 *     own app's secret?" months later.
 * So the transfer is refused with an error that names the reason. Enforced at INITIATE
 * (fail fast) AND re-asserted in-tx at ACCEPT — an offer stays open for
 * `transferExpiryDays`, and a revision approve can LINK a client in that window, so an
 * initiate-time check alone would be false for the whole window.
 *
 * ## What deliberately does NOT move
 *
 *   - `AppListingPublishRequest.submittedByUserId` — historical submission record,
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
 * On accept of an ON-SITE listing: revoke the OLD owner's repo write, grant the NEW
 * owner's. An OFF-SITE listing has no repo, so neither call fires. Collaborator seats
 * are untouched by a transfer — the listing keeps its editors.
 */

export type TransferView = {
  id: string;
  appListingId: string;
  fromUserId: number;
  toUserId: number;
  status: string;
  expiresAt: Date;
  createdAt: Date;
};

/** The message a connect-linked off-site listing is refused with. Asserted verbatim. */
export const CONNECT_CLIENT_TRANSFER_REFUSAL =
  'This listing is linked to an OAuth application. Ownership transfer would either hand ' +
  'over that application’s credentials or split ownership between the listing and the ' +
  'client, so it is not available for connect listings. Unlink the OAuth client first.';

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

/**
 * 🔴 THE ONE PREDICATE for "may this listing's ownership move?", written once so the
 * initiate-time check and the in-tx accept-time re-assert cannot drift apart.
 *
 * On-site listings are unaffected: their connect column is always null (an on-site
 * listing's OauthClient is reached through the AppBlock, and THAT one does move).
 */
export function refusesTransferForConnectClient(listing: {
  kind: string;
  connectClientId: string | null;
}): boolean {
  return listing.kind === 'offsite' && listing.connectClientId != null;
}

type OwnedListing = {
  appListingId: string;
  slug: string;
  kind: ListingKind;
  /** Backing AppBlock id — null for off-site. */
  appBlockId: string | null;
  /** The AppBlock's OauthClient id (the CANONICAL onsite owner column). Null offsite. */
  appId: string | null;
  /** The AppBlock's `blockId` — the Forgejo repo slug. Null offsite. */
  blockSlug: string | null;
  connectClientId: string | null;
  ownerUserId: number;
};

async function loadOwnedListing(appListingId: string, actorUserId: number): Promise<OwnedListing> {
  const row = (await dbRead.appListing.findUnique({
    where: { id: appListingId },
    select: {
      id: true,
      slug: true,
      kind: true,
      userId: true,
      appBlockId: true,
      connectClientId: true,
      revisionOfId: true,
      appBlock: { select: { appId: true, blockId: true, app: { select: { userId: true } } } },
    },
  })) as {
    id: string;
    slug: string;
    kind: string;
    userId: number;
    appBlockId: string | null;
    connectClientId: string | null;
    revisionOfId: string | null;
    appBlock: { appId: string; blockId: string; app: { userId: number } | null } | null;
  } | null;
  if (!row) throw new AppCollaboratorError('NOT_FOUND', 'App listing not found');
  // A shadow revision is an internal draft, not a thing anyone can own or hand over.
  // Refused rather than hopped to the parent: "transfer this draft" has no meaning.
  if (row.revisionOfId != null) {
    throw new AppCollaboratorError(
      'INVALID_TARGET',
      'Ownership is transferred on the live listing, not on a revision draft'
    );
  }
  const ownerUserId = row.appBlock?.app?.userId ?? row.userId;
  if (ownerUserId !== actorUserId) {
    throw new AppCollaboratorError('NOT_OWNER', 'Only the app owner can transfer ownership');
  }
  return {
    appListingId: row.id,
    slug: row.slug,
    kind: row.kind as ListingKind,
    appBlockId: row.appBlockId,
    appId: row.appBlock?.appId ?? null,
    blockSlug: row.appBlock?.blockId ?? null,
    connectClientId: row.connectClientId,
    ownerUserId,
  };
}

/**
 * OWNER: offer ownership to another user. Creates a `pending` transfer; NOTHING moves
 * until the recipient accepts.
 *
 * 🔴 A PENDING TRANSFER CONFERS ZERO CAPABILITY on the recipient — it is not a seat,
 * it does not appear in `resolveListingAccess`, and it grants no repo access. Same
 * consent principle as a pending invite.
 *
 * One in-flight transfer per listing, enforced by the migration's PARTIAL UNIQUE index
 * (`app_listing_id WHERE status='pending'`), which Prisma cannot express. A concurrent
 * second initiate loses on P2002 and is surfaced as a friendly error rather than a
 * raw constraint violation.
 */
export async function initiateTransfer(opts: {
  appListingId: string;
  toUserId: number;
  actorUserId: number;
  now?: Date;
}): Promise<TransferView> {
  const now = opts.now ?? new Date();
  const listing = await loadOwnedListing(opts.appListingId, opts.actorUserId);

  // 🔴 FAIL FAST on a connect-linked off-site listing — see the module header. The
  // same predicate is re-asserted in-tx at accept, because a revision approve can link
  // a client while the offer sits open.
  if (refusesTransferForConnectClient(listing)) {
    throw new AppCollaboratorError('INVALID_TARGET', CONNECT_CLIENT_TRANSFER_REFUSAL);
  }

  if (opts.toUserId === listing.ownerUserId) {
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
  // block every future transfer for this listing once one invitation lapsed.
  await dbWrite.appOwnershipTransfer.updateMany({
    where: { appListingId: listing.appListingId, status: 'pending', expiresAt: { lte: now } },
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
          appListingId: listing.appListingId,
          fromUserId: listing.ownerUserId,
          toUserId: opts.toUserId,
          status: 'pending',
          expiresAt,
        },
        select: {
          id: true,
          appListingId: true,
          fromUserId: true,
          toUserId: true,
          status: true,
          expiresAt: true,
          createdAt: true,
        },
      })) as TransferView;
      await recordOwnershipEvent(tx, {
        appListingId: listing.appListingId,
        slug: listing.slug,
        action: 'transfer_initiated',
        actorUserId: opts.actorUserId,
        targetUserId: opts.toUserId,
        metadata: { transferId: id, kind: listing.kind, expiresAt: expiresAt.toISOString() },
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
      details: {
        slug: listing.slug,
        appListingId: listing.appListingId,
        appBlockId: listing.appBlockId,
      },
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
 *   1c. 🔴 re-assert the CONNECT-CLIENT refusal against the listing AS IT IS NOW. A
 *      revision approve can link an OAuth client after the offer was made, so the
 *      initiate-time check says nothing about this instant;
 *   2. ONSITE ONLY — re-assert `OauthClient.userId` STILL equals the transfer's
 *      `fromUserId` via a status-guarded `updateMany` whose 0-count means the owner
 *      changed since the offer, rolling everything back;
 *   3. move `AppListing.userId`;
 *   4. flip the transfer to `accepted`;
 *   5. write the audit event.
 *
 * 🔴 STEP 3 IS GUARDED FOR OFFSITE AND UNGUARDED FOR ONSITE, and the asymmetry is the
 * point. Onsite: step 2 is the authority (the canonical column) and step 3 is the
 * denormalized follow-up, where a 0-count is a legitimate desync that must not fail the
 * transfer. Offsite: step 2 does not run at all, so step 3's `userId = fromUserId`
 * predicate is the ONLY TOCTOU protection there is — a mod `claimListing` landing in
 * the window makes it match 0 rows, and the accept is refused rather than silently
 * undoing the moderator's remedy.
 *
 * NOT touched, by design: `AppListingPublishRequest.submittedByUserId`,
 * `BlockBuzzAttribution.appOwnerUserId`, collaborator seats. See the module header.
 */
export async function acceptTransfer(opts: {
  transferId: string;
  userId: number;
  now?: Date;
}): Promise<{ transferId: string; appListingId: string; fromUserId: number; toUserId: number }> {
  const now = opts.now ?? new Date();

  const result = await dbWrite.$transaction(async (tx) => {
    const transfer = (await tx.appOwnershipTransfer.findUnique({
      where: { id: opts.transferId },
      select: {
        id: true,
        appListingId: true,
        fromUserId: true,
        toUserId: true,
        status: true,
        expiresAt: true,
        appListing: {
          select: {
            id: true,
            slug: true,
            kind: true,
            connectClientId: true,
            appBlockId: true,
            appBlock: { select: { appId: true, blockId: true } },
          },
        },
      },
    })) as
      | (TransferView & {
          appListing: {
            id: string;
            slug: string;
            kind: string;
            connectClientId: string | null;
            appBlockId: string | null;
            appBlock: { appId: string; blockId: string } | null;
          } | null;
        })
      | null;

    if (!transfer || !transfer.appListing) {
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

    // (1c) 🔴 RE-ASSERT the connect-client refusal on the CURRENT listing row. Same
    // reasoning as (1b): a revision approve can link an OAuth client while the offer is
    // open, and moving a listing out from under live credentials is the outcome this
    // whole decision exists to prevent.
    if (refusesTransferForConnectClient(transfer.appListing)) {
      throw new AppCollaboratorError('INVALID_TARGET', CONNECT_CLIENT_TRANSFER_REFUSAL);
    }

    const isOnsite = transfer.appListing.kind === 'onsite';
    const appId = transfer.appListing.appBlock?.appId ?? null;

    // (2) CANONICAL owner column — ONSITE ONLY, status-guarded on the snapshotted
    // previous owner. An off-site listing has no OauthClient in its ownership chain.
    if (isOnsite) {
      if (!appId) {
        throw new AppCollaboratorError(
          'NOT_FOUND',
          'This listing’s app record is missing; ownership cannot be transferred'
        );
      }
      const movedClient = await tx.oauthClient.updateMany({
        where: { id: appId, userId: transfer.fromUserId },
        data: { userId: transfer.toUserId },
      });
      if (movedClient.count === 0) {
        throw new AppCollaboratorError(
          'NO_INVITE',
          'Ownership of this app has changed; this transfer can no longer be accepted'
        );
      }
    }

    // (3) The listing's owner column. See the asymmetry note in the header: guarded
    // for offsite (it is the ONLY ownership write there), unguarded for onsite (a
    // denormalized copy whose 0-count is a legitimate desync).
    const movedListing = await tx.appListing.updateMany({
      where: isOnsite
        ? { id: transfer.appListingId }
        : { id: transfer.appListingId, userId: transfer.fromUserId },
      data: { userId: transfer.toUserId },
    });
    if (!isOnsite && movedListing.count === 0) {
      throw new AppCollaboratorError(
        'NO_INVITE',
        'Ownership of this listing has changed; this transfer can no longer be accepted'
      );
    }

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
      appListingId: transfer.appListingId,
      slug: transfer.appListing.slug,
      action: 'transfer_accepted',
      actorUserId: opts.userId,
      targetUserId: opts.userId,
      metadata: {
        transferId: transfer.id,
        kind: transfer.appListing.kind,
        before: { userId: transfer.fromUserId },
        after: { userId: transfer.toUserId },
      },
    });

    return {
      transferId: transfer.id,
      appListingId: transfer.appListingId,
      fromUserId: transfer.fromUserId,
      toUserId: transfer.toUserId,
      slug: transfer.appListing.slug,
      appBlockId: transfer.appListing.appBlockId,
      blockSlug: transfer.appListing.appBlock?.blockId ?? null,
    };
  });

  // POST-COMMIT external effects. Swap the repo grants: the old owner loses write, the
  // new owner gains it. ON-SITE ONLY — an off-site listing has no repo. Collaborator
  // seats are unaffected either way: the listing keeps its editors.
  if (result.blockSlug) {
    await revokeAppRepoWrite({ slug: result.blockSlug, userId: result.fromUserId });
    await grantAppRepoWrite({ slug: result.blockSlug, userId: result.toUserId });
  }

  try {
    await notifyAppCollaborator({
      type: 'app-ownership-transfer-accepted',
      userId: result.fromUserId,
      key: `app-ownership-transfer-accepted:${result.transferId}`,
      details: {
        slug: result.slug,
        appListingId: result.appListingId,
        appBlockId: result.appBlockId,
      },
    });
  } catch {
    /* best-effort, post-commit */
  }

  return {
    transferId: result.transferId,
    appListingId: result.appListingId,
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
        appListingId: true,
        fromUserId: true,
        toUserId: true,
        status: true,
        expiresAt: true,
        appListing: { select: { slug: true } },
      },
    })) as (TransferView & { appListing: { slug: string } | null }) | null;

    if (!transfer || !transfer.appListing) {
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
      appListingId: transfer.appListingId,
      slug: transfer.appListing.slug,
      action: 'transfer_cancelled',
      actorUserId: opts.actorUserId,
      targetUserId: transfer.toUserId,
      metadata: { transferId: transfer.id },
    });
    return { transferId: transfer.id, cancelled: true };
  });
}

/**
 * The LIVE pending transfer for a listing, or `null`. Expiry is applied as a read-time
 * predicate (see {@link isLive}) so an expired row never surfaces as pending, whether
 * or not anything has swept it.
 *
 * 🔴 AUTHORIZED, like its three siblings. The row names BOTH parties (`fromUserId`,
 * `toUserId`) and the offer's deadline; every other transfer proc gates
 * (`initiateTransfer` → owner, `acceptTransfer` → addressee, `cancelTransfer` → either
 * party), and this one took no caller at all, so any flagged account could read who is
 * handing which app to whom. Permitted: the listing OWNER (who is the offer's
 * `fromUserId`) and the ADDRESSEE, matching exactly the set that may act on the transfer.
 *
 * An unauthorized caller gets `null`, NOT a FORBIDDEN. Throwing would make this proc an
 * existence ORACLE — "this listing has a pending transfer" is itself the private fact —
 * so the refusal is made indistinguishable from "there is no offer". (`NOT_FOUND` for a
 * missing listing is fine: listing existence is already public.)
 */
export async function getPendingTransfer(opts: {
  appListingId: string;
  /** The caller. Required — this is not a public read; see above. */
  viewerUserId: number;
  now?: Date;
}): Promise<TransferView | null> {
  const now = opts.now ?? new Date();
  const { resolveListingAccess } = await import('~/server/services/blocks/app-access.service');
  const access = await resolveListingAccess(opts.appListingId, opts.viewerUserId);
  if (!access) throw new AppCollaboratorError('NOT_FOUND', 'App listing not found');
  const row = (await dbRead.appOwnershipTransfer.findFirst({
    where: { appListingId: access.seatListingId, status: 'pending' },
    select: {
      id: true,
      appListingId: true,
      fromUserId: true,
      toUserId: true,
      status: true,
      expiresAt: true,
      createdAt: true,
    },
  })) as TransferView | null;
  if (!row || !isLive(row, now)) return null;
  // Owner or addressee only. An EDITOR is deliberately excluded: a seat is a content
  // capability, and disposing of the listing is the one thing an editor may not do or
  // initiate — so it is not theirs to watch either.
  if (access.role !== 'owner' && row.toUserId !== opts.viewerUserId) return null;
  return row;
}
