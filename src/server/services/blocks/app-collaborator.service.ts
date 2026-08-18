import { TRPCError } from '@trpc/server';
import type { Prisma } from '@prisma/client';

import { constants } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  ACCEPTED,
  listingKindSupports,
  resolveCanonicalListingOwner,
  resolveListingAccess,
  type ListingKind,
} from '~/server/services/blocks/app-access.service';
import { notifyAppCollaborator } from '~/server/services/blocks/app-collaborator-notify';
import { grantAppRepoWrite, revokeAppRepoWrite } from '~/server/services/blocks/app-repo-access';
import { newAppOwnershipEventId } from '~/server/utils/app-block-ids';

/**
 * App Listing COLLABORATORS — the SEAT lifecycle (invite / accept / reject / remove /
 * leave / byline opt-in).
 *
 * 🔴 SEATS ARE KEYED TO THE APP **LISTING**. See `app-access.service`'s header for why
 * (an off-site listing has no AppBlock, so a block-keyed seat could not exist for one
 * of the store's two kinds).
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
 *
 * ## Forgejo is ON-SITE ONLY
 *
 * The repo grant/revoke that rides along with accept / remove / leave fires ONLY when
 * the listing's KIND supports `submitVersion` AND a repo slug exists. An off-site
 * listing has no bundle and no repo — the `submitVersion: false` capability cell — so
 * there is nothing to grant, and calling Forgejo with a store slug that names no repo
 * would be a guaranteed 404 on every off-site seat decision.
 *
 * 🔴 THE KIND IS THE AUTHORITY AND THE SLUG IS ONLY THE PHYSICAL CHECK — see
 * {@link hasWritableRepo}. Gating on the slug ALONE looks equivalent and is not: an
 * `offsite` listing CAN carry a backing AppBlock (and therefore a `blockId` slug), so a
 * slug-only gate would mint repo write on a listing whose kind declares it has no
 * version surface at all.
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
  appListingId: string;
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
    appListingId: string;
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
      appListingId: args.appListingId,
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

/**
 * The listing a seat operation acts on, already resolved to the SEAT-BEARING PARENT.
 *
 * `blockSlug` is the Forgejo repo name and is `null` for an off-site listing — every
 * repo call is conditioned on it, so an off-site seat decision never reaches Forgejo.
 */
type SeatListing = {
  /** The PARENT listing id — the seat key. */
  appListingId: string;
  /** The store slug (audit-event identity, notification copy). */
  slug: string;
  kind: ListingKind;
  /** Backing AppBlock id, or null for off-site. */
  appBlockId: string | null;
  /** The AppBlock's `blockId` — the Forgejo repo slug. Null for off-site. */
  blockSlug: string | null;
  /** Canonical owner: the OauthClient owner for onsite, the listing column for offsite. */
  ownerUserId: number;
  /** True when the id handed in was a SHADOW revision (already hopped to the parent). */
  wasShadow: boolean;
};

const seatListingSelect = {
  id: true,
  slug: true,
  kind: true,
  userId: true,
  appBlockId: true,
  revisionOfId: true,
  appBlock: { select: { blockId: true, app: { select: { userId: true } } } },
} as const;

type RawSeatListing = {
  id: string;
  slug: string;
  kind: string;
  userId: number;
  appBlockId: string | null;
  revisionOfId: string | null;
  appBlock: { blockId: string; app: { userId: number } | null } | null;
};

function toSeatListing(row: RawSeatListing, wasShadow: boolean): SeatListing {
  return {
    appListingId: row.id,
    slug: row.slug,
    kind: row.kind as ListingKind,
    appBlockId: row.appBlockId,
    blockSlug: row.appBlock?.blockId ?? null,
    // 🔴 KIND-AWARE, through the SHARED resolver — not a second spelling of it. This used
    // to be written here as `row.appBlock?.app?.userId ?? row.userId`, i.e. BLOCK-FIRST,
    // which is wrong on an OFFSITE listing that carries a block (issue #3844): the block
    // names the previous owner after `claimListing`/`acceptTransfer`, so this gate —
    // `assertOwner`, i.e. seat MANAGEMENT — would let an impersonator a moderator had
    // just dispossessed keep inviting and removing collaborators on the rightful owner's
    // listing. `row` is always the PARENT (loadSeatListing hops a shadow first), so the
    // column passed here is the canonical one and not a frozen clone.
    ownerUserId: resolveCanonicalListingOwner({
      kind: row.kind,
      blockOwnerUserId: row.appBlock?.app?.userId,
      listingUserId: row.userId,
    }),
    wasShadow,
  };
}

/**
 * 🔴 THE ONE PREDICATE for "may a Forgejo repo call fire for this listing?", written
 * once so the grant (accept) and the two revokes (remove / leave) cannot drift apart.
 *
 * BOTH clauses are load-bearing and they are NOT redundant:
 *   - `listingKindSupports(kind, 'submitVersion')` is the DECLARED capability, and it is
 *     the authority. `CAPABILITIES_BY_KIND` fails closed on an unrecognised kind, so a
 *     kind this code does not know is refused rather than granted.
 *   - `blockSlug != null` is the PHYSICAL check — there must be a repo name to call.
 *
 * They disagree on exactly one shape, and it is reachable: `mapAppBlockToListing` mints
 * `kind:'offsite'` with a non-null `appBlockId` whenever the source AppBlock has an
 * `externalUrl`, so such a listing HAS a `blockId` slug while declaring
 * `submitVersion: false`. A slug-only gate would hand that listing's collaborator
 * Forgejo `write`.
 *
 * 🔴 A TYPE PREDICATE, not a `boolean` — and here is EXACTLY what that buys, because an
 * earlier version of this comment claimed a safety property the compiler does not
 * provide. The three call sites pass `listing.blockSlug` to a Forgejo call that requires
 * a `string`, and they used to do it through a `!` non-null assertion justified by a
 * comment ("safe: `hasWritableRepo` is precisely the null check"). The predicate replaces
 * that comment with narrowing the compiler performs, so the three `!`s are gone and the
 * three call sites can no longer be re-written to pass a nullable slug without tsc
 * objecting.
 *
 * 🔴 WHAT IT DOES **NOT** BUY: TypeScript NEVER checks a user-defined predicate's BODY
 * against the declared predicate. Relaxing this body to a kind-only check is a silent
 * change — measured on this tree with `pnpm typecheck`: the relaxed body emits **0**
 * errors, while the positive control (same relaxed body, return type demoted to
 * `boolean`) emits exactly **3** — `TS2322: Type 'string | null' is not assignable to
 * type 'string'`, one per call site (`respondToInvite`, `removeCollaborator`,
 * `leaveApp`) as each loses the narrowing. So the predicate is checked at its CALLERS and
 * unchecked at its DEFINITION, and the null-slug half of this function has no
 * compile-time guard at all.
 *
 * That half is therefore pinned BEHAVIOURALLY, by `app-collaborator.service.test.ts` →
 * "🔴 an ON-SITE listing with NO backing block reaches Forgejo NEVER". That case is the
 * only one that can kill a body relaxed to `listingKindSupports(...)` alone: every other
 * on-site fixture has a slug, so both clauses agree and either one alone satisfies them.
 */
function hasWritableRepo(listing: {
  kind: string;
  blockSlug: string | null;
}): listing is { kind: string; blockSlug: string } {
  return listingKindSupports(listing.kind, 'submitVersion') && listing.blockSlug != null;
}

/**
 * Load the SEAT-BEARING listing for `appListingId`, hopping a shadow revision to its
 * parent.
 *
 * 🔴 THE SINGLE RESOLVE-TO-PARENT PATH for the write side (the read side is
 * `resolveListingAccess`). A seat may only ever exist on a parent — see
 * `app-access.service`'s header — so every seat mutation must land there, and handing
 * one a shadow id must NOT silently create a second, doomed seat namespace.
 */
async function loadSeatListing(appListingId: string): Promise<SeatListing> {
  const row = (await dbRead.appListing.findUnique({
    where: { id: appListingId },
    select: seatListingSelect,
  })) as RawSeatListing | null;
  if (!row) throw new AppCollaboratorError('NOT_FOUND', 'App listing not found');
  if (!row.revisionOfId) return toSeatListing(row, false);
  const parent = (await dbRead.appListing.findUnique({
    where: { id: row.revisionOfId },
    select: seatListingSelect,
  })) as RawSeatListing | null;
  if (!parent) throw new AppCollaboratorError('NOT_FOUND', 'App listing not found');
  return toSeatListing(parent, true);
}

/**
 * Load the listing + assert the caller OWNS it. Editors are refused: seats are
 * owner-managed.
 */
async function assertOwner(appListingId: string, actorUserId: number): Promise<SeatListing> {
  const listing = await loadSeatListing(appListingId);
  if (listing.ownerUserId !== actorUserId) {
    throw new AppCollaboratorError('NOT_OWNER', 'Only the app owner can manage collaborators');
  }
  return listing;
}

export type InviteCollaboratorResult = {
  appListingId: string;
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
 * 🔴 A SHADOW REVISION IS REFUSED OUTRIGHT — the seat-creation half of the
 * parent-only invariant. Silently hopping to the parent here would be *safe* but
 * *wrong to teach*: an owner who thinks they are seating "the revision" would be
 * seating the live listing, and the UI would have to explain a hop the product does
 * not have. Refusing names the truth: collaborators are a property of the LISTING.
 * The other direction — a seat that landed on a shadow being destroyed by
 * `applyApprovedRevision`'s CASCADE delete — is what makes this a safety guard and not
 * a nicety.
 *
 * 🔴 BAN POLICY (decided, and applied consistently across this feature): a BANNED user
 * may neither be invited nor accept. Rationale: on an on-site listing a seat grants
 * Forgejo `write` on the app repo plus visibility of the app's earnings, and
 * `getMyAppRepo` already refuses to issue a push credential to a banned account
 * (`blocks.router.ts:5579`). Seating a banned user would mint exactly the credential
 * that gate exists to withhold. An EXISTING seat is NOT auto-revoked on ban (that
 * would need a ban-hook this PR does not add) — but every capability the seat unlocks
 * re-checks `bannedAt` at the proc, so a banned editor can hold an inert row and do
 * nothing with it.
 */
export async function inviteCollaborator(opts: {
  appListingId: string;
  targetUserId: number;
  actorUserId: number;
  now?: Date;
}): Promise<InviteCollaboratorResult> {
  const now = opts.now ?? new Date();

  // 🔴 SHADOW CHECK FIRST, and on the id AS SUPPLIED — `assertOwner` resolves to the
  // parent, so asking it afterwards could never see the shadow.
  const asked = await dbRead.appListing.findUnique({
    where: { id: opts.appListingId },
    select: { id: true, revisionOfId: true },
  });
  if (!asked) throw new AppCollaboratorError('NOT_FOUND', 'App listing not found');
  if (asked.revisionOfId != null) {
    throw new AppCollaboratorError(
      'INVALID_TARGET',
      'Collaborators are managed on the live listing, not on a revision draft'
    );
  }

  const listing = await assertOwner(opts.appListingId, opts.actorUserId);

  if (opts.targetUserId === listing.ownerUserId) {
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
    where: {
      appListingId_userId: { appListingId: listing.appListingId, userId: opts.targetUserId },
    },
    select: { status: true, lastNotifiedAt: true },
  });

  if (existing?.status === ACCEPTED) {
    throw new AppCollaboratorError('ALREADY_SEATED', 'That user is already a collaborator');
  }

  // CAP — counts PENDING + ACCEPTED (a rejected row is inert and occupies no seat).
  // Skipped when re-touching a row that already exists, since that consumes no new seat.
  if (!existing) {
    const seated = await dbWrite.appCollaborator.count({
      where: { appListingId: listing.appListingId, status: { in: ['pending', ACCEPTED] } },
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
      where: {
        appListingId_userId: { appListingId: listing.appListingId, userId: opts.targetUserId },
      },
      create: {
        appListingId: listing.appListingId,
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
      appListingId: listing.appListingId,
      slug: listing.slug,
      action: 'invite',
      actorUserId: opts.actorUserId,
      targetUserId: opts.targetUserId,
      metadata: { role: 'editor', kind: listing.kind, reopened: existing?.status === 'rejected' },
    });
  });

  if (notify) {
    // Post-commit + best-effort: a notification failure must never undo the invite.
    try {
      await notifyAppCollaborator({
        type: 'app-collaborator-invited',
        userId: opts.targetUserId,
        key: `app-collaborator-invited:${listing.appListingId}:${
          opts.targetUserId
        }:${now.getTime()}`,
        details: {
          slug: listing.slug,
          appListingId: listing.appListingId,
          appBlockId: listing.appBlockId,
        },
      });
    } catch {
      /* best-effort */
    }
  }

  return {
    appListingId: listing.appListingId,
    userId: opts.targetUserId,
    status: 'pending',
    created: !existing,
    notified: notify,
  };
}

export type RespondToInviteResult = { appListingId: string; userId: number; status: string };

/**
 * INVITEE: accept or decline a pending seat.
 *
 * Status-guarded `updateMany` (`status:'pending'`), so a concurrent remove/re-invite
 * cannot be double-acted: a 0-count means the invite is no longer pending → NO_INVITE,
 * and the transaction rolls back before any audit event is written.
 *
 * On ACCEPT this also grants the collaborator Forgejo `write` on `civitai-apps/<slug>`
 * — the seat is worthless without push access, and the grant is part of accepting, not
 * a follow-up. 🔴 ON-SITE ONLY: an off-site listing has no repo, so the grant is
 * skipped entirely rather than called with a slug that names nothing. The grant runs
 * POST-COMMIT and is best-effort-logged: it is an external system, and a Forgejo
 * outage must not roll back a consent decision the user made. `getMyAppRepo` re-grants
 * on demand, so a dropped grant self-heals on first use.
 */
export async function respondToInvite(opts: {
  appListingId: string;
  userId: number;
  accept: boolean;
  now?: Date;
}): Promise<RespondToInviteResult> {
  const now = opts.now ?? new Date();
  const listing = await loadSeatListing(opts.appListingId);

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
      where: { appListingId: listing.appListingId, userId: opts.userId, status: 'pending' },
      data: { status: nextStatus, respondedAt: now },
    });
    if (flipped.count === 0) {
      throw new AppCollaboratorError('NO_INVITE', 'There is no pending invitation to respond to');
    }
    await recordOwnershipEvent(tx, {
      appListingId: listing.appListingId,
      slug: listing.slug,
      action: opts.accept ? 'accept' : 'reject',
      actorUserId: opts.userId,
      targetUserId: opts.userId,
    });
  });

  // 🔴 KIND-GATED, not slug-gated — see {@link hasWritableRepo}. It is a TYPE PREDICATE,
  // so `blockSlug` narrows to `string` here; no non-null assertion is involved.
  if (opts.accept && hasWritableRepo(listing)) {
    await grantAppRepoWrite({ slug: listing.blockSlug, userId: opts.userId });
  }

  return { appListingId: listing.appListingId, userId: opts.userId, status: nextStatus };
}

/**
 * OWNER: remove a collaborator (any status).
 *
 * Deletes the row rather than tombstoning it — the audit trail is the
 * `AppOwnershipEvent`, and leaving a `rejected`-like tombstone would keep occupying
 * conceptual space in the roster read for no benefit.
 *
 * REVOKES Forgejo write (on-site only). This is the half with no prior art in the
 * codebase: there was no revoke path at all before this feature
 * (`forgejo.service.ts` had `addCollaborator` and nothing to undo it), which meant a
 * dev who was granted push access kept it forever.
 */
export async function removeCollaborator(opts: {
  appListingId: string;
  targetUserId: number;
  actorUserId: number;
}): Promise<{ appListingId: string; userId: number; removed: boolean }> {
  const listing = await assertOwner(opts.appListingId, opts.actorUserId);

  const removed = await dbWrite.$transaction(async (tx) => {
    const del = await tx.appCollaborator.deleteMany({
      where: { appListingId: listing.appListingId, userId: opts.targetUserId },
    });
    if (del.count === 0) return false;
    await recordOwnershipEvent(tx, {
      appListingId: listing.appListingId,
      slug: listing.slug,
      action: 'remove',
      actorUserId: opts.actorUserId,
      targetUserId: opts.targetUserId,
    });
    return true;
  });

  if (removed && hasWritableRepo(listing)) {
    await revokeAppRepoWrite({ slug: listing.blockSlug, userId: opts.targetUserId });
  }
  return { appListingId: listing.appListingId, userId: opts.targetUserId, removed };
}

/**
 * COLLABORATOR: give up your own seat. Consent, not management — so this is the one
 * seat mutation an editor may perform, and it needs no owner check.
 */
export async function leaveApp(opts: {
  appListingId: string;
  userId: number;
}): Promise<{ appListingId: string; userId: number; removed: boolean }> {
  const listing = await loadSeatListing(opts.appListingId);

  const removed = await dbWrite.$transaction(async (tx) => {
    const del = await tx.appCollaborator.deleteMany({
      where: { appListingId: listing.appListingId, userId: opts.userId },
    });
    if (del.count === 0) return false;
    await recordOwnershipEvent(tx, {
      appListingId: listing.appListingId,
      slug: listing.slug,
      action: 'leave',
      actorUserId: opts.userId,
      targetUserId: opts.userId,
    });
    return true;
  });

  if (removed && hasWritableRepo(listing)) {
    await revokeAppRepoWrite({ slug: listing.blockSlug, userId: opts.userId });
  }
  return { appListingId: listing.appListingId, userId: opts.userId, removed };
}

/**
 * Set the PUBLIC BYLINE flag on a seat — either the caller's own, or (as the app OWNER
 * or a moderator) someone else's.
 *
 * 🔴 APPLIES IMMEDIATELY — no mod review, and no shadow revision. That is only safe
 * because the flag lives on the collaborator row: `applyApprovedRevision`'s offsite
 * branch copies the shadow's listing SCALARS onto the live parent, so the same flag
 * held as an `AppListing` column would be silently reverted by the next approved
 * revision. Being outside both branches' copy sets makes immediate-apply correct by
 * construction. `app-collaborator.revision-non-clobber.test.ts` pins that.
 *
 * Only an ACCEPTED seat may be flagged — nobody, owner included, may pre-arrange public
 * credit for an invitation that has not been taken.
 *
 * ## 🔴 WHO MAY SET IT — a deliberate product decision, recorded as one
 *
 * `targetUserId` is OPTIONAL:
 *   - ABSENT (or equal to the caller) → SELF-SERVICE. Unchanged behaviour, and the shape
 *     this proc already shipped with; a collaborator always controls their own byline.
 *   - PRESENT and someone else → the caller must be the listing OWNER or a MODERATOR.
 *
 * The owner branch means an owner CAN remove a collaborator's public credit while leaving
 * their seat intact. The narrower model — `displayed` as a preference belonging solely to
 * the person named — was implemented first and explicitly overruled; this is the chosen
 * product behaviour, not an oversight, and it is written down because the code alone
 * cannot distinguish the two.
 *
 * The MODERATOR branch is granted for consistency with {@link listCollaborators}, which
 * already admits a moderator to the full roster including `displayed:false` seats: a
 * public byline is moderatable content.
 *
 * 🔴 OWNERSHIP IS RESOLVED CANONICALLY (`loadSeatListing` → `toSeatListing`, i.e.
 * `AppBlock.app.userId` first and the denormalized `AppListing.userId` only as the
 * off-site fallback). Comparing against the column would fail in BOTH directions on a
 * drifted row — refusing the real owner on their own app while admitting whoever the
 * stale row names, who could then strip a stranger's credit. Pinned both ways in
 * `app-collaborator.service.test.ts`.
 *
 * 🔴 LAST WRITER WINS, and that is the v1 rule stated on purpose so the next reader does
 * not invent a precedence one. There is no record of WHO last set the flag and no
 * owner-over-collaborator (or collaborator-over-owner) priority: an owner can hide a
 * collaborator who then shows themselves again, and vice versa. If that turns out to
 * matter, it needs a stored provenance column and its own decision — do not simulate one
 * by reading the audit log.
 *
 * The refusal message is VERBATIM and deliberately DIFFERENT from `assertOwner`'s
 * ('Only the app owner can manage collaborators'), so a mutation that breaks this gate
 * dies to THIS error rather than to a neighbouring owner check.
 */
export async function setCollaboratorDisplayed(opts: {
  appListingId: string;
  /** The CALLER. */
  userId: number;
  /** Whose flag to set. Omitted ⇒ the caller's own row. */
  targetUserId?: number;
  displayed: boolean;
  /** Moderator override — see the header. */
  isModerator?: boolean;
}): Promise<{ appListingId: string; userId: number; displayed: boolean }> {
  const listing = await loadSeatListing(opts.appListingId);
  const targetUserId = opts.targetUserId ?? opts.userId;

  if (targetUserId !== opts.userId) {
    // 🔴 `listing.ownerUserId` is the CANONICAL owner, not `AppListing.userId`.
    const isOwner = listing.ownerUserId === opts.userId;
    if (!isOwner && !opts.isModerator) {
      throw new AppCollaboratorError(
        'NOT_OWNER',
        'Only the app owner can change a collaborator’s public byline'
      );
    }
  }

  await dbWrite.$transaction(async (tx) => {
    const updated = await tx.appCollaborator.updateMany({
      where: { appListingId: listing.appListingId, userId: targetUserId, status: ACCEPTED },
      data: { displayed: opts.displayed },
    });
    if (updated.count === 0) {
      throw new AppCollaboratorError(
        'NO_INVITE',
        targetUserId === opts.userId
          ? 'You are not an active collaborator on this app'
          : 'That user is not an active collaborator on this app'
      );
    }
    await recordOwnershipEvent(tx, {
      appListingId: listing.appListingId,
      slug: listing.slug,
      action: 'display',
      // 🔴 actor ≠ target once an owner can act on someone else's seat. Recording the
      // caller as BOTH (the pre-change shape) would make an owner-driven un-crediting
      // indistinguishable in the audit log from the collaborator opting out themselves.
      actorUserId: opts.userId,
      targetUserId,
      metadata: { displayed: opts.displayed, byOwner: targetUserId !== opts.userId },
    });
  });

  return {
    appListingId: listing.appListingId,
    userId: targetUserId,
    displayed: opts.displayed,
  };
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
 * Filter roster ROWS by the status-visibility rules `EntityCollaborator` established
 * (the part of that prior art worth reusing):
 *
 *   accepted → visible to any caller that reaches this function
 *   pending  → visible to the app owner, the invitee themselves, and moderators
 *   rejected → visible to the app owner and moderators only
 *
 * 🔴 "Any caller that reaches this function" is NOT "everyone". This is a row filter,
 * never an access check: its only production caller is `listCollaborators`, which
 * ALREADY refused anyone who is not the owner, an ACCEPTED editor, or a moderator.
 * Do not read the `accepted → everyone` line as a statement about who may call the
 * proc — that gate lives in `listCollaborators` and is the load-bearing one.
 *
 * Consequently two branches below are unreachable from that caller and are retained
 * only as defence-in-depth for a future second caller: the `viewerUserId == null`
 * early return (a non-moderator caller must hold a role, so it is never anonymous),
 * and the `row.userId === viewerUserId` disjunct in the `pending` arm (a role-holder
 * cannot simultaneously hold a `pending` row). Their unit tests pin an invariant, not
 * behaviour any current caller can reach.
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

/**
 * 🔴 THE ROSTER IS NOT A PUBLIC READ, and `resolveListingAccess` is consulted for its
 * ROLE, not merely for `ownerUserId`.
 *
 * Reading it back leaks, for any listing on the platform: the full ACCEPTED roster
 * INCLUDING seats whose holder opted OUT of the public byline (`displayed: false` — the
 * whole point of that flag is that those people are not listed publicly), plus
 * `invitedBy` and the invite/response timestamps. The status filter below governs
 * pending/rejected ROWS; it never governed whether the CALLER may read the listing at
 * all, so without this gate every flagged account could enumerate every listing's
 * collaborators.
 *
 * Permitted: the listing OWNER, an ACCEPTED editor, or a moderator. A PENDING invitee is
 * NOT — they read their own standing invitation through `listMyPendingInvites`, which
 * is keyed to their own user id and needs no listing-scoped access.
 */
export async function listCollaborators(opts: {
  appListingId: string;
  viewerUserId: number | null;
  isModerator: boolean;
}): Promise<CollaboratorView[]> {
  const access = await resolveListingAccess(opts.appListingId, opts.viewerUserId);
  if (!access) throw new AppCollaboratorError('NOT_FOUND', 'App listing not found');
  if (!access.role && !opts.isModerator) {
    throw new AppCollaboratorError(
      'NOT_OWNER',
      'You do not have access to this app’s collaborators'
    );
  }
  const rows = (await dbRead.appCollaborator.findMany({
    // 🔴 `seatListingId`, not the id asked for: a caller who opened the roster from a
    // shadow revision must see the parent's seats, not an empty list.
    where: { appListingId: access.seatListingId },
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
export async function listMyPendingInvites(userId: number): Promise<
  Array<{
    appListingId: string;
    slug: string;
    kind: ListingKind;
    appBlockId: string | null;
    invitedBy: number;
    createdAt: Date;
  }>
> {
  const rows = await dbRead.appCollaborator.findMany({
    where: { userId, status: 'pending' },
    select: {
      appListingId: true,
      invitedBy: true,
      createdAt: true,
      appListing: { select: { slug: true, kind: true, appBlockId: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(
    (r: {
      appListingId: string;
      invitedBy: number;
      createdAt: Date;
      appListing: { slug: string; kind: string; appBlockId: string | null } | null;
    }) => ({
      appListingId: r.appListingId,
      slug: r.appListing?.slug ?? '',
      kind: (r.appListing?.kind ?? 'offsite') as ListingKind,
      appBlockId: r.appListing?.appBlockId ?? null,
      invitedBy: r.invitedBy,
      createdAt: r.createdAt,
    })
  );
}
