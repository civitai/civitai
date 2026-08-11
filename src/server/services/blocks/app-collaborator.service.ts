import { TRPCError } from '@trpc/server';
import type { Prisma } from '@prisma/client';

import { constants } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import { ACCEPTED, resolveAppAccess } from '~/server/services/blocks/app-access.service';
import { notifyAppCollaborator } from '~/server/services/blocks/app-collaborator-notify';
import { grantAppRepoWrite, revokeAppRepoWrite } from '~/server/services/blocks/app-repo-access';
import { newAppOwnershipEventId } from '~/server/utils/app-block-ids';

/**
 * App Listing COLLABORATORS — the SEAT lifecycle (invite / accept / reject / remove /
 * leave / byline opt-in).
 *
 * ## What is copied from `EntityCollaborator`, and what deliberately is not
 *
 * COPIED — the CONSENT MODEL, which is the part worth reusing: an invite starts
 * `pending`, confers nothing, and the status-visibility rules mirror
 * `entity-collaborator.service.ts::getEntityCollaborators:181-199` (accepted → visible
 * to everyone; pending → owner, invitee, mod; rejected → owner, mod).
 *
 * NOT COPIED:
 *   - its CODE (hard-scoped to `EntityType.Post`; every function throws on anything else);
 *   - its DELIVERY mechanism (a system chat message via `upsertChat`/`createMessage`).
 *     We use the existing App Blocks notification path instead;
 *   - 🔴 its THROTTLE, which is INVERTED. `entity-collaborator.service.ts:94-95` reads
 *     `lastMessageSentAt >= dayjs().subtract(1,'day')` — i.e. "notify again when the
 *     last notification was RECENT" — while its own sibling
 *     `sendMessagesToCollaborators:312` correctly uses `lte`. Ours is written the
 *     correct way round (see {@link shouldNotifyInvite}) and the test pins both sides
 *     of the boundary so a future copy-paste cannot re-import the bug.
 *
 * ## Owner-only
 *
 * Managing collaborators is reserved to the OWNER. An editor is otherwise effectively
 * a co-owner, but may not seat or unseat anyone (that plus initiating a transfer are
 * the only two owner-reserved actions). An editor MAY remove themselves ({@link
 * leaveApp}) — that is consent, not management.
 */

export type AppCollaboratorErrorCode =
  | 'NOT_FOUND'
  | 'NOT_OWNER'
  | 'INVALID_TARGET'
  | 'ALREADY_SEATED'
  | 'CAP_REACHED'
  | 'NO_INVITE'
  | 'BANNED';

export class AppCollaboratorError extends Error {
  readonly code: AppCollaboratorErrorCode;
  constructor(code: AppCollaboratorErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AppCollaboratorError';
    this.code = code;
  }
}

/** Map a typed service error onto the tRPC code the client should see. */
export function mapCollaboratorError(err: unknown): unknown {
  if (!(err instanceof AppCollaboratorError)) return err;
  const code =
    err.code === 'NOT_FOUND'
      ? 'NOT_FOUND'
      : err.code === 'NOT_OWNER' || err.code === 'BANNED'
      ? 'FORBIDDEN'
      : 'BAD_REQUEST';
  return new TRPCError({ code, message: err.message, cause: err });
}

export type CollaboratorRow = {
  appBlockId: string;
  userId: number;
  role: string;
  status: string;
  displayed: boolean;
  invitedBy: number;
  createdAt: Date;
  respondedAt: Date | null;
};

/**
 * Write an append-only ownership/collaboration audit event.
 *
 * Takes an explicit `tx` so a caller inside a transaction records the event in the
 * SAME transaction — a rolled-back action must leave ZERO events (the discipline
 * `claimListing` established for `AppListingModerationEvent`).
 */
export async function recordOwnershipEvent(
  /**
   * The transaction client. Typed as `Prisma.TransactionClient` (not a hand-rolled
   * structural shape) so a schema change to `AppOwnershipEvent` breaks HERE at compile
   * time rather than being absorbed by a `Record<string, unknown>` that types nothing.
   */
  tx: Prisma.TransactionClient,
  args: {
    appBlockId: string;
    slug: string;
    action:
      | 'invite'
      | 'accept'
      | 'reject'
      | 'remove'
      | 'leave'
      | 'display'
      | 'transfer_initiated'
      | 'transfer_accepted'
      | 'transfer_cancelled';
    actorUserId: number;
    targetUserId?: number | null;
    metadata?: Record<string, unknown> | null;
  }
): Promise<void> {
  await tx.appOwnershipEvent.create({
    data: {
      id: newAppOwnershipEventId(),
      appBlockId: args.appBlockId,
      slug: args.slug,
      action: args.action,
      actorUserId: args.actorUserId,
      targetUserId: args.targetUserId ?? null,
      metadata: (args.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}

/**
 * Re-notify throttle for a repeat invite.
 *
 * 🔴 WRITTEN THE OPPOSITE WAY ROUND FROM `entity-collaborator.service.ts:94-95`, which
 * is the bug being avoided. The rule is: notify when we have NEVER notified, OR when
 * the last notification is OLDER than the window. `lastNotifiedAt` newer than the
 * cutoff ⇒ stay silent.
 */
export function shouldNotifyInvite(lastNotifiedAt: Date | null, now: Date): boolean {
  if (!lastNotifiedAt) return true;
  const cutoff = new Date(
    now.getTime() - constants.appCollaborators.inviteNotifyThrottleHours * 3600_000
  );
  return lastNotifiedAt.getTime() <= cutoff.getTime();
}

/** Load the app + assert the caller OWNS it. Editors are refused: seats are owner-managed. */
async function assertOwner(
  appBlockId: string,
  actorUserId: number
): Promise<{ appBlockId: string; slug: string; ownerUserId: number }> {
  const block = await dbRead.appBlock.findUnique({
    where: { id: appBlockId },
    select: { id: true, blockId: true, app: { select: { userId: true } } },
  });
  if (!block?.app) throw new AppCollaboratorError('NOT_FOUND', 'App not found');
  if (block.app.userId !== actorUserId) {
    throw new AppCollaboratorError('NOT_OWNER', 'Only the app owner can manage collaborators');
  }
  return { appBlockId: block.id, slug: block.blockId, ownerUserId: block.app.userId };
}

export type InviteCollaboratorResult = {
  appBlockId: string;
  userId: number;
  status: string;
  /** True when this call created the row (vs re-touching a standing invite). */
  created: boolean;
  /** True when a notification was actually emitted (the throttle may suppress it). */
  notified: boolean;
};

/**
 * OWNER: invite a user to an editor seat.
 *
 * Idempotent. A repeat invite for a standing `pending` row does NOT reset the row; it
 * only (throttled) re-notifies. A repeat invite for an `accepted` row is
 * ALREADY_SEATED. A repeat invite for a `rejected` row RE-OPENS it as `pending` —
 * declining is not permanent, and the invitee must consent again.
 *
 * 🔴 BAN POLICY (decided, and applied consistently across this feature): a BANNED user
 * may neither be invited nor accept. Rationale: a seat grants Forgejo `write` on the
 * app repo plus visibility of the app's earnings, and `getMyAppRepo` already refuses
 * to issue a push credential to a banned account (`blocks.router.ts:5579`). Seating a
 * banned user would mint exactly the credential that gate exists to withhold. An
 * EXISTING seat is NOT auto-revoked on ban (that would need a ban-hook this PR does
 * not add) — but every capability the seat unlocks re-checks `bannedAt` at the proc,
 * so a banned editor can hold an inert row and do nothing with it.
 */
export async function inviteCollaborator(opts: {
  appBlockId: string;
  targetUserId: number;
  actorUserId: number;
  now?: Date;
}): Promise<InviteCollaboratorResult> {
  const now = opts.now ?? new Date();
  const app = await assertOwner(opts.appBlockId, opts.actorUserId);

  if (opts.targetUserId === app.ownerUserId) {
    throw new AppCollaboratorError(
      'INVALID_TARGET',
      'The app owner already has full access and cannot be invited as a collaborator'
    );
  }
  const target = await dbRead.user.findUnique({
    where: { id: opts.targetUserId },
    select: { id: true, bannedAt: true },
  });
  if (!target) {
    throw new AppCollaboratorError('INVALID_TARGET', 'That user could not be found');
  }
  if (target.bannedAt) {
    throw new AppCollaboratorError(
      'BANNED',
      'That account is not eligible for a collaborator seat'
    );
  }

  const existing = await dbRead.appCollaborator.findUnique({
    where: { appBlockId_userId: { appBlockId: app.appBlockId, userId: opts.targetUserId } },
    select: { status: true, lastNotifiedAt: true },
  });

  if (existing?.status === ACCEPTED) {
    throw new AppCollaboratorError('ALREADY_SEATED', 'That user is already a collaborator');
  }

  // CAP — counts PENDING + ACCEPTED (a rejected row is inert and occupies no seat).
  // Skipped when re-touching a row that already exists, since that consumes no new seat.
  if (!existing) {
    const seated = await dbWrite.appCollaborator.count({
      where: { appBlockId: app.appBlockId, status: { in: ['pending', ACCEPTED] } },
    });
    if (seated >= constants.appCollaborators.maxCollaborators) {
      throw new AppCollaboratorError(
        'CAP_REACHED',
        `An app can have at most ${constants.appCollaborators.maxCollaborators} collaborators`
      );
    }
  }

  const notify = shouldNotifyInvite(existing?.lastNotifiedAt ?? null, now);

  await dbWrite.$transaction(async (tx) => {
    await tx.appCollaborator.upsert({
      where: { appBlockId_userId: { appBlockId: app.appBlockId, userId: opts.targetUserId } },
      create: {
        appBlockId: app.appBlockId,
        userId: opts.targetUserId,
        role: 'editor',
        status: 'pending',
        invitedBy: opts.actorUserId,
        lastNotifiedAt: notify ? now : null,
      },
      update: {
        // Re-open a declined invite; leave a standing pending row's createdAt alone.
        status: 'pending',
        respondedAt: null,
        invitedBy: opts.actorUserId,
        ...(notify ? { lastNotifiedAt: now } : {}),
      },
    });
    await recordOwnershipEvent(tx, {
      appBlockId: app.appBlockId,
      slug: app.slug,
      action: 'invite',
      actorUserId: opts.actorUserId,
      targetUserId: opts.targetUserId,
      metadata: { role: 'editor', reopened: existing?.status === 'rejected' },
    });
  });

  if (notify) {
    // Post-commit + best-effort: a notification failure must never undo the invite.
    try {
      await notifyAppCollaborator({
        type: 'app-collaborator-invited',
        userId: opts.targetUserId,
        key: `app-collaborator-invited:${app.appBlockId}:${opts.targetUserId}:${now.getTime()}`,
        details: { slug: app.slug, appBlockId: app.appBlockId },
      });
    } catch {
      /* best-effort */
    }
  }

  return {
    appBlockId: app.appBlockId,
    userId: opts.targetUserId,
    status: 'pending',
    created: !existing,
    notified: notify,
  };
}

export type RespondToInviteResult = { appBlockId: string; userId: number; status: string };

/**
 * INVITEE: accept or decline a pending seat.
 *
 * Status-guarded `updateMany` (`status:'pending'`), so a concurrent remove/re-invite
 * cannot be double-acted: a 0-count means the invite is no longer pending → NO_INVITE,
 * and the transaction rolls back before any audit event is written.
 *
 * On ACCEPT this also grants the collaborator Forgejo `write` on `civitai-apps/<slug>`
 * — the seat is worthless without push access, and the grant is part of accepting, not
 * a follow-up. The grant runs POST-COMMIT and is best-effort-logged: it is an external
 * system, and a Forgejo outage must not roll back a consent decision the user made.
 * `getMyAppRepo` re-grants on demand, so a dropped grant self-heals on first use.
 */
export async function respondToInvite(opts: {
  appBlockId: string;
  userId: number;
  accept: boolean;
  now?: Date;
}): Promise<RespondToInviteResult> {
  const now = opts.now ?? new Date();
  const block = await dbRead.appBlock.findUnique({
    where: { id: opts.appBlockId },
    select: { id: true, blockId: true },
  });
  if (!block) throw new AppCollaboratorError('NOT_FOUND', 'App not found');

  if (opts.accept) {
    const user = await dbRead.user.findUnique({
      where: { id: opts.userId },
      select: { bannedAt: true },
    });
    if (user?.bannedAt) {
      throw new AppCollaboratorError(
        'BANNED',
        'Your account is not eligible for a collaborator seat'
      );
    }
  }

  const nextStatus = opts.accept ? ACCEPTED : 'rejected';

  await dbWrite.$transaction(async (tx) => {
    const flipped = await tx.appCollaborator.updateMany({
      where: { appBlockId: block.id, userId: opts.userId, status: 'pending' },
      data: { status: nextStatus, respondedAt: now },
    });
    if (flipped.count === 0) {
      throw new AppCollaboratorError('NO_INVITE', 'There is no pending invitation to respond to');
    }
    await recordOwnershipEvent(tx, {
      appBlockId: block.id,
      slug: block.blockId,
      action: opts.accept ? 'accept' : 'reject',
      actorUserId: opts.userId,
      targetUserId: opts.userId,
    });
  });

  if (opts.accept) {
    await grantAppRepoWrite({ slug: block.blockId, userId: opts.userId });
  }

  return { appBlockId: block.id, userId: opts.userId, status: nextStatus };
}

/**
 * OWNER: remove a collaborator (any status).
 *
 * Deletes the row rather than tombstoning it — the audit trail is the
 * `AppOwnershipEvent`, and leaving a `rejected`-like tombstone would keep occupying
 * conceptual space in the roster read for no benefit.
 *
 * REVOKES Forgejo write. This is the half with no prior art in the codebase: there was
 * no revoke path at all before this PR (`forgejo.service.ts` had `addCollaborator` and
 * nothing to undo it), which meant a dev who was granted push access kept it forever.
 */
export async function removeCollaborator(opts: {
  appBlockId: string;
  targetUserId: number;
  actorUserId: number;
}): Promise<{ appBlockId: string; userId: number; removed: boolean }> {
  const app = await assertOwner(opts.appBlockId, opts.actorUserId);

  const removed = await dbWrite.$transaction(async (tx) => {
    const del = await tx.appCollaborator.deleteMany({
      where: { appBlockId: app.appBlockId, userId: opts.targetUserId },
    });
    if (del.count === 0) return false;
    await recordOwnershipEvent(tx, {
      appBlockId: app.appBlockId,
      slug: app.slug,
      action: 'remove',
      actorUserId: opts.actorUserId,
      targetUserId: opts.targetUserId,
    });
    return true;
  });

  if (removed) {
    await revokeAppRepoWrite({ slug: app.slug, userId: opts.targetUserId });
  }
  return { appBlockId: app.appBlockId, userId: opts.targetUserId, removed };
}

/**
 * COLLABORATOR: give up your own seat. Consent, not management — so this is the one
 * seat mutation an editor may perform, and it needs no owner check.
 */
export async function leaveApp(opts: {
  appBlockId: string;
  userId: number;
}): Promise<{ appBlockId: string; userId: number; removed: boolean }> {
  const block = await dbRead.appBlock.findUnique({
    where: { id: opts.appBlockId },
    select: { id: true, blockId: true },
  });
  if (!block) throw new AppCollaboratorError('NOT_FOUND', 'App not found');

  const removed = await dbWrite.$transaction(async (tx) => {
    const del = await tx.appCollaborator.deleteMany({
      where: { appBlockId: block.id, userId: opts.userId },
    });
    if (del.count === 0) return false;
    await recordOwnershipEvent(tx, {
      appBlockId: block.id,
      slug: block.blockId,
      action: 'leave',
      actorUserId: opts.userId,
      targetUserId: opts.userId,
    });
    return true;
  });

  if (removed) {
    await revokeAppRepoWrite({ slug: block.blockId, userId: opts.userId });
  }
  return { appBlockId: block.id, userId: opts.userId, removed };
}

/**
 * COLLABORATOR: opt in/out of the public byline.
 *
 * 🔴 APPLIES IMMEDIATELY — no mod review, and no shadow revision. That is only safe
 * because the flag lives on the collaborator row: `applyApprovedRevision`'s offsite
 * branch copies the shadow's listing SCALARS onto the live parent, so the same flag
 * held as an `AppListing` column would be silently reverted by the next approved
 * revision. Being outside both branches' copy sets makes immediate-apply correct by
 * construction. `app-collaborator.revision-non-clobber.test.ts` pins that.
 *
 * Only an ACCEPTED collaborator may set it — a pending invitee toggling `displayed`
 * must not be able to pre-arrange public credit for a seat they have not taken.
 */
export async function setCollaboratorDisplayed(opts: {
  appBlockId: string;
  userId: number;
  displayed: boolean;
}): Promise<{ appBlockId: string; userId: number; displayed: boolean }> {
  const block = await dbRead.appBlock.findUnique({
    where: { id: opts.appBlockId },
    select: { id: true, blockId: true },
  });
  if (!block) throw new AppCollaboratorError('NOT_FOUND', 'App not found');

  await dbWrite.$transaction(async (tx) => {
    const updated = await tx.appCollaborator.updateMany({
      where: { appBlockId: block.id, userId: opts.userId, status: ACCEPTED },
      data: { displayed: opts.displayed },
    });
    if (updated.count === 0) {
      throw new AppCollaboratorError('NO_INVITE', 'You are not an active collaborator on this app');
    }
    await recordOwnershipEvent(tx, {
      appBlockId: block.id,
      slug: block.blockId,
      action: 'display',
      actorUserId: opts.userId,
      targetUserId: opts.userId,
      metadata: { displayed: opts.displayed },
    });
  });

  return { appBlockId: block.id, userId: opts.userId, displayed: opts.displayed };
}

export type CollaboratorView = {
  userId: number;
  role: string;
  status: string;
  displayed: boolean;
  invitedBy: number;
  createdAt: Date;
  respondedAt: Date | null;
};

/**
 * List an app's collaborators, filtered by the SAME status-visibility rules
 * `EntityCollaborator` established (the part of that prior art worth reusing):
 *
 *   accepted → visible to everyone
 *   pending  → visible to the app owner, the invitee themselves, and moderators
 *   rejected → visible to the app owner and moderators only
 *
 * Anything else is filtered out. An anonymous caller (`viewerUserId == null`) sees
 * ACCEPTED only.
 */
export function filterCollaboratorsForViewer(
  rows: CollaboratorView[],
  ctx: { ownerUserId: number; viewerUserId: number | null; isModerator: boolean }
): CollaboratorView[] {
  return rows.filter((row) => {
    if (row.status === ACCEPTED) return true;
    if (ctx.isModerator) return true;
    if (ctx.viewerUserId == null) return false;
    if (row.status === 'pending') {
      return ctx.ownerUserId === ctx.viewerUserId || row.userId === ctx.viewerUserId;
    }
    if (row.status === 'rejected') return ctx.ownerUserId === ctx.viewerUserId;
    return false;
  });
}

export async function listCollaborators(opts: {
  appBlockId: string;
  viewerUserId: number | null;
  isModerator: boolean;
}): Promise<CollaboratorView[]> {
  const access = await resolveAppAccess(opts.appBlockId, opts.viewerUserId);
  if (!access) throw new AppCollaboratorError('NOT_FOUND', 'App not found');
  const rows = (await dbRead.appCollaborator.findMany({
    where: { appBlockId: opts.appBlockId },
    select: {
      userId: true,
      role: true,
      status: true,
      displayed: true,
      invitedBy: true,
      createdAt: true,
      respondedAt: true,
    },
    orderBy: { createdAt: 'asc' },
  })) as CollaboratorView[];
  return filterCollaboratorsForViewer(rows, {
    ownerUserId: access.ownerUserId,
    viewerUserId: opts.viewerUserId,
    isModerator: opts.isModerator,
  });
}

/** The caller's own PENDING invitations, for an inbox surface. */
export async function listMyPendingInvites(
  userId: number
): Promise<Array<{ appBlockId: string; slug: string; invitedBy: number; createdAt: Date }>> {
  const rows = await dbRead.appCollaborator.findMany({
    where: { userId, status: 'pending' },
    select: {
      appBlockId: true,
      invitedBy: true,
      createdAt: true,
      appBlock: { select: { blockId: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(
    (r: {
      appBlockId: string;
      invitedBy: number;
      createdAt: Date;
      appBlock: { blockId: string } | null;
    }) => ({
      appBlockId: r.appBlockId,
      slug: r.appBlock?.blockId ?? '',
      invitedBy: r.invitedBy,
      createdAt: r.createdAt,
    })
  );
}
