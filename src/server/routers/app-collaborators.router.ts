import { TRPCError } from '@trpc/server';

import {
  getAppEarningsSchema,
  getPendingAppTransferSchema,
  initiateAppTransferSchema,
  inviteAppCollaboratorSchema,
  leaveAppSchema,
  listAppCollaboratorsSchema,
  removeAppCollaboratorSchema,
  respondToAppInviteSchema,
  setCollaboratorDisplayedSchema,
  transferIdSchema,
} from '~/server/schema/blocks/app-collaborator.schema';
import { isAppBlocksAuthorEnabled } from '~/server/services/app-blocks-flag';
import { rateLimit } from '~/server/middleware.trpc';
import { appDeveloperProcedure, middleware, protectedProcedure, router } from '~/server/trpc';
import type { SessionUser } from '~/types/session';

/**
 * App Listing COLLABORATORS — seat management, ownership transfer, and the APP-SCOPED
 * earnings read.
 *
 * A NEW router rather than an extension of `blocks.router`/`app-listings.router`,
 * mirroring the locked decision that put the store-listing procs in their own router.
 *
 * ## Flag gating
 *
 * Everything here sits behind the SAME mod-segmented App Blocks author flag as the
 * neighbouring authoring procs — `appDeveloperProcedure` (which composes
 * `hasAppBlocksAuthor`) for owner/editor actions, plus `enforceAppBlocksAuthorFlag`
 * on the invitee-facing procs.
 *
 * 🔴 The two INVITEE-facing procs (`respondToInvite`, `listMyPendingInvites`) and the
 * transfer-recipient procs use `protectedProcedure + enforceAppBlocksAuthorFlag`
 * rather than `appDeveloperProcedure`, which is the same composition — stated
 * explicitly because the subtle alternative is wrong: an invitee is not yet an author
 * of anything, so gating them on "do you already own an app" would make the very first
 * invite unacceptable. The author FLAG (a mod floor + the `app-dev-testers` cohort) is
 * the right gate; app ownership is not.
 *
 * ## Keyed on the APP LISTING, so it serves BOTH store kinds
 *
 * Every proc takes `appListingId`. Seats are keyed to `AppListing` (see
 * `app-access.service`'s header) precisely so an OFF-SITE listing — which has no
 * AppBlock at all — can hold collaborators. What a seat then UNLOCKS is derived from
 * the listing's kind, not from anything sent over the wire: `getAppEarnings` refuses an
 * off-site listing with `unsupportedKind`, and the version/git surface is block-keyed
 * so it is unreachable for one by construction.
 *
 * ## No PRE-EXISTING input schema is changed
 *
 * Every proc here is NEW AND UNCONSUMED, which is what makes re-keying their inputs
 * from `appBlockId` to `appListingId` a non-event: no released `civitai` CLI version
 * and no shipped client calls `appCollaborators.*`. The `AppBlocksSubmit`-scoped
 * listing-media procs that the CLI DOES drive are untouched — `app-collaborator.cli-
 * contract.test.ts` pins their schemas so the distinction is proven, not asserted.
 *
 * None of these procs carries a CLI scope annotation: the CLI has no collaborator
 * commands, and an un-annotated proc implicitly requires `TokenScope.Full`, which a
 * session (or a Full personal key) satisfies via `enforceTokenScope`'s early return.
 * Annotate the day a CLI command needs one.
 */

const enforceAppBlocksAuthorFlag = middleware(async ({ ctx, next }) => {
  if (await isAppBlocksAuthorEnabled({ user: ctx.user })) return next();
  throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Apps authoring is not enabled' });
});

/** Map the service's typed errors onto tRPC codes; pass anything else through. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  const { mapCollaboratorError } = await import(
    '~/server/services/blocks/app-collaborator.service'
  );
  try {
    return await fn();
  } catch (err) {
    throw mapCollaboratorError(err);
  }
}

/**
 * A BANNED account may not take a seat-granting or ownership-granting action.
 *
 * 🔴 THE BAN DECISION, applied in one place so it cannot drift between procs:
 * a banned user may NOT be invited, may NOT accept an invite, and may NOT receive an
 * ownership transfer. Rationale: a seat mints Forgejo `write` on the app repo and
 * exposes the app's earnings, and `getMyAppRepo` already refuses to issue a push
 * credential to a banned account — seating a banned user would hand out exactly the
 * credential that gate withholds.
 *
 * An EXISTING seat is NOT auto-revoked on ban (that needs a ban-hook this change does
 * not add), but every capability it unlocks re-checks `bannedAt` at the proc, so a
 * banned editor holds an inert row. `protectedProcedure`'s `isAuthed` already refuses
 * banned sessions outright; these are defence-in-depth, matching the sibling
 * `blocks.router` procs' explicit re-checks.
 */
function assertNotBanned(user: SessionUser | undefined): void {
  if (user?.bannedAt) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Your account is not eligible for app collaboration',
    });
  }
}

export const appCollaboratorsRouter = router({
  // -------------------------------------------------------------------------
  // OWNER: seat management.
  // -------------------------------------------------------------------------

  /**
   * OWNER: invite a user to an editor seat. Idempotent; re-invites are throttled
   * (notification only). Rate-limited so an owner cannot spray invitations.
   */
  invite: appDeveloperProcedure
    .use(
      rateLimit({
        limit: 30,
        period: 3600,
        errorMessage: 'Too many collaborator invitations — slow down.',
      })
    )
    .input(inviteAppCollaboratorSchema)
    .mutation(async ({ ctx, input }) => {
      assertNotBanned(ctx.user as SessionUser);
      const { inviteCollaborator } = await import(
        '~/server/services/blocks/app-collaborator.service'
      );
      return run(() =>
        inviteCollaborator({
          appListingId: input.appListingId,
          targetUserId: input.targetUserId,
          actorUserId: ctx.user!.id,
        })
      );
    }),

  /** OWNER: remove a collaborator (any status). Revokes their repo write. */
  remove: appDeveloperProcedure
    .input(removeAppCollaboratorSchema)
    .mutation(async ({ ctx, input }) => {
      const { removeCollaborator } = await import(
        '~/server/services/blocks/app-collaborator.service'
      );
      return run(() =>
        removeCollaborator({
          appListingId: input.appListingId,
          targetUserId: input.targetUserId,
          actorUserId: ctx.user!.id,
        })
      );
    }),

  // -------------------------------------------------------------------------
  // INVITEE / COLLABORATOR.
  // -------------------------------------------------------------------------

  /**
   * INVITEE: accept or decline a pending seat.
   *
   * Gated on the author FLAG, not on `appDeveloperProcedure`'s ownership-flavoured
   * read — see the router header. A banned account may not accept.
   */
  respondToInvite: protectedProcedure
    .use(enforceAppBlocksAuthorFlag)
    .input(respondToAppInviteSchema)
    .mutation(async ({ ctx, input }) => {
      if (input.accept) assertNotBanned(ctx.user as SessionUser);
      const { respondToInvite } = await import('~/server/services/blocks/app-collaborator.service');
      return run(() =>
        respondToInvite({
          appListingId: input.appListingId,
          userId: ctx.user!.id,
          accept: input.accept,
        })
      );
    }),

  /** COLLABORATOR: give up your own seat. Consent, not management — no owner check. */
  leave: protectedProcedure
    .use(enforceAppBlocksAuthorFlag)
    .input(leaveAppSchema)
    .mutation(async ({ ctx, input }) => {
      const { leaveApp } = await import('~/server/services/blocks/app-collaborator.service');
      return run(() => leaveApp({ appListingId: input.appListingId, userId: ctx.user!.id }));
    }),

  /**
   * COLLABORATOR: opt in/out of the PUBLIC BYLINE. Applies immediately (no mod
   * review) — safe by construction because the flag lives on the collaborator row,
   * outside the shadow-revision copy sets. See the service.
   */
  setDisplayed: protectedProcedure
    .use(enforceAppBlocksAuthorFlag)
    .input(setCollaboratorDisplayedSchema)
    .mutation(async ({ ctx, input }) => {
      const { setCollaboratorDisplayed } = await import(
        '~/server/services/blocks/app-collaborator.service'
      );
      return run(() =>
        setCollaboratorDisplayed({
          appListingId: input.appListingId,
          userId: ctx.user!.id,
          displayed: input.displayed,
        })
      );
    }),

  /** The caller's own pending invitations (inbox). */
  listMyPendingInvites: protectedProcedure
    .use(enforceAppBlocksAuthorFlag)
    .query(async ({ ctx }) => {
      const { listMyPendingInvites } = await import(
        '~/server/services/blocks/app-collaborator.service'
      );
      return run(() => listMyPendingInvites(ctx.user!.id));
    }),

  // -------------------------------------------------------------------------
  // READ.
  // -------------------------------------------------------------------------

  /**
   * The app's roster. 🔴 NOT a public read — two gates apply, in this order:
   *
   *   1. ACCESS. The caller must be the app OWNER, an ACCEPTED editor, or a
   *      moderator (`listCollaborators` throws NOT_OWNER otherwise). A PENDING
   *      invitee is refused here — they read their own standing invitation via
   *      `listMyPendingInvites`, which is keyed to their own user id.
   *   2. STATUS. Within an app the caller may already read, rows are filtered by
   *      the `EntityCollaborator` status rules (pending → owner/invitee/mod;
   *      rejected → owner/mod).
   *
   * Gate 1 is the load-bearing one and is NEW: the status filter alone never
   * governed whether the caller may read the app at all, so without it any
   * flagged account could enumerate every app's roster — including seats whose
   * holder opted OUT of the public byline (`displayed: false`).
   *
   * Both are enforced in the SERVICE, so neither can be bypassed by a different
   * caller. See `listCollaborators`.
   */
  list: protectedProcedure
    .use(enforceAppBlocksAuthorFlag)
    .input(listAppCollaboratorsSchema)
    .query(async ({ ctx, input }) => {
      const { listCollaborators } = await import(
        '~/server/services/blocks/app-collaborator.service'
      );
      return run(() =>
        listCollaborators({
          appListingId: input.appListingId,
          viewerUserId: ctx.user?.id ?? null,
          isModerator: !!ctx.user?.isModerator,
        })
      );
    }),

  /**
   * APP-SCOPED earnings — the collaborator money surface.
   *
   * 🔴 NOT a widening of `blocks.getMyRevenue`. That proc is keyed on the snapshotted
   * `appOwnerUserId` and is USER-WIDE; reusing it for an editor (by passing the
   * owner's id) would return the owner's ENTIRE PORTFOLIO. This one resolves the
   * caller's role on THIS listing and filters by its `appBlockId` + the app's CURRENT
   * owner. Returns an explicit `notPermitted` rather than a zero, so a caller can never
   * read "no access" as "earned nothing".
   *
   * 🔴 ON-SITE ONLY, returning `unsupportedKind` for an off-site listing.
   * `BlockBuzzAttribution` is keyed on `appBlockId`, which an off-site listing does not
   * have — so there is nothing to sum, and a zeroed summary would be a lie.
   */
  getAppEarnings: appDeveloperProcedure
    .input(getAppEarningsSchema)
    .query(async ({ ctx, input }) => {
      const { getAppEarnings } = await import(
        '~/server/services/blocks/app-collaborator-earnings.service'
      );
      return run(() =>
        getAppEarnings({
          appListingId: input.appListingId,
          userId: ctx.user!.id,
          from: input.from ? new Date(input.from) : undefined,
          to: input.to ? new Date(input.to) : undefined,
        })
      );
    }),

  // -------------------------------------------------------------------------
  // OWNERSHIP TRANSFER.
  // -------------------------------------------------------------------------

  /**
   * OWNER: offer ownership to another user. NOTHING moves until they accept, and a
   * pending offer confers ZERO capability on the recipient.
   */
  initiateTransfer: appDeveloperProcedure
    .use(
      rateLimit({
        limit: 10,
        period: 3600,
        errorMessage: 'Too many ownership transfer attempts — slow down.',
      })
    )
    .input(initiateAppTransferSchema)
    .mutation(async ({ ctx, input }) => {
      assertNotBanned(ctx.user as SessionUser);
      const { initiateTransfer } = await import(
        '~/server/services/blocks/app-ownership-transfer.service'
      );
      return run(() =>
        initiateTransfer({
          appListingId: input.appListingId,
          toUserId: input.toUserId,
          actorUserId: ctx.user!.id,
        })
      );
    }),

  /**
   * RECIPIENT: accept. Moves `OauthClient.userId` AND `AppListing.userId` in ONE
   * transaction; leaves submission history and Buzz attribution untouched.
   */
  acceptTransfer: protectedProcedure
    .use(enforceAppBlocksAuthorFlag)
    .input(transferIdSchema)
    .mutation(async ({ ctx, input }) => {
      assertNotBanned(ctx.user as SessionUser);
      const { acceptTransfer } = await import(
        '~/server/services/blocks/app-ownership-transfer.service'
      );
      return run(() => acceptTransfer({ transferId: input.transferId, userId: ctx.user!.id }));
    }),

  /** Either party cancels: the owner withdraws the offer, or the recipient declines. */
  cancelTransfer: protectedProcedure
    .use(enforceAppBlocksAuthorFlag)
    .input(transferIdSchema)
    .mutation(async ({ ctx, input }) => {
      const { cancelTransfer } = await import(
        '~/server/services/blocks/app-ownership-transfer.service'
      );
      return run(() => cancelTransfer({ transferId: input.transferId, actorUserId: ctx.user!.id }));
    }),

  /**
   * The LIVE pending transfer for an app (expiry applied as a read-time predicate).
   *
   * 🔴 Takes `ctx`, and passes the caller down. The transfer row names both parties and
   * the deadline; the service restricts it to the app OWNER and the ADDRESSEE — the same
   * set the three sibling transfer procs gate on — and returns `null` (never FORBIDDEN)
   * to anyone else, so this read cannot be used as an existence oracle.
   */
  getPendingTransfer: appDeveloperProcedure
    .input(getPendingAppTransferSchema)
    .query(async ({ ctx, input }) => {
      const { getPendingTransfer } = await import(
        '~/server/services/blocks/app-ownership-transfer.service'
      );
      return run(() =>
        getPendingTransfer({ appListingId: input.appListingId, viewerUserId: ctx.user!.id })
      );
    }),
});
