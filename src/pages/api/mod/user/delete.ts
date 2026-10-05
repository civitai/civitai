import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { trackModActivity } from '~/server/services/moderator.service';
import { deleteUser } from '~/server/services/user.service';
import { TRPCError } from '@trpc/server';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import { defineModeratorEndpoint, moderatorBoolean } from '~/server/utils/moderator-endpoint';
import { userId } from '~/server/schema/moderator/user';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { Flags } from '~/shared/utils/flags';

export default defineModeratorEndpoint('user.delete', {
  summary: "Delete an account on its owner's behalf, for a data-subject erasure request.",
  returns: '{ deleted: true, userId, auditRecorded }',
  notes: [
    'Calls the same `deleteUser` service the self-serve path uses — one definition of deletion.',
    'Refuses a delegated token that is not full-scope. A cookie session carries no scope and is unaffected.',
    'Requires the moderator app permission `user.deleteAccount`: held by `moderator:admin`, and by any role granted it on the moderator app’s `/admin`.',
    '`username` is REQUIRED for any account that has one — it is the only check that catches a mistyped id landing on another live account. Accounts with a null username, and already-deleted rows, do not ask for it.',
    'Refuses an account that is already deleted rather than re-running the scrub.',
    'Images are kept for the 7-day grace period unless you send `removeImages: true`. An erasure asking for immediate removal needs that flag set deliberately, and THE CHOICE IS ONE-SHOT: once the account is deleted this endpoint refuses it. Getting it wrong costs a 7-day delay, not permanent retention — the purge still runs on day 7.',
    'Records a `deleteAccount` ModActivity row against the acting moderator. `auditRecorded: false` means the deletion succeeded and that row did not land.',
  ],
  // A FAT-FINGER BOUND, NOT A SECURITY ONE. It slows a script that loops; it does not serialise two
  // concurrent calls. Sized to leave a real erasure backlog workable in one sitting, so if you are
  // tuning it, trade it against that rather than against an attacker.
  rateLimit: { max: 5, windowSeconds: 60 },
  // 🔴 THE CONFIRMATION IS NOT RECORDED. Everywhere else this feature REMOVES the username —
  // `deleteUser` nulls it, and the ModActivity row carries ids only. Without this, the audit row
  // would be the single place the erased person's identifier survives their erasure, kept because
  // it happened to be a request parameter rather than because anybody chose to keep it. The check
  // still runs; the user id is the durable key an investigation needs, and it is still recorded.
  auditExclude: ['username'],
  input: z.object({
    userId,
    // NOT `usernameSchema`: that regex allows `[A-Za-z0-9_]` only, and about 630 live rows
    // (2026-09-22) are outside it. Validating a moderator's confirmation against it would 400 on
    // exactly the odd accounts this endpoint exists for.
    username: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'REQUIRED for any account that has a username — it must match. Optional only for an account whose username is null, and for one already deleted. Send it in the body, never the query string.'
      ),
    removeModels: moderatorBoolean
      .optional()
      .describe(
        'True deletes their models; otherwise ownership moves to the deleted-user sentinel.'
      ),
    // DEFAULTED, not optional, and `false` is the safe end. `imageRemovalMode` reads
    // `removeImages === false ? 'grace' : 'immediate'`, so an absent value would mean immediate,
    // irrecoverable destruction — the destructive choice as the accidental one, on the one
    // deletion path whose caller is not the person whose images they are.
    removeImages: moderatorBoolean
      .default(false)
      .describe('True deletes the images now. Default keeps them for the 7-day grace period.'),
  }),
  async handler(input, ctx) {
    // A DELEGATED TOKEN MAY NOT REACH FURTHER HERE THAN IT REACHES THROUGH tRPC. `user.delete` there
    // is `requiredScope: TokenScope.Full`, so a narrowly-scoped token cannot delete even its own
    // account; without this, one scoped for something unrelated could delete anybody's.
    //
    // It is a CEILING on delegated tokens, not a floor on everyone: `enforceTokenScope` runs its
    // check only when the scope is not Full, and an un-delegated request resolves to Full — so a
    // cookie-authenticated moderator is not scope-checked there or here. This buys SCOPE parity and
    // not AUTHORITY parity: tRPC can only erase the caller's own account, a Full token here erases
    // anyone's. `Flags.hasFlag` rather than a restated comparison, so it cannot drift from
    // `enforceTokenScope`.
    if (!Flags.hasFlag(ctx.tokenScope, TokenScope.Full))
      // FORBIDDEN, not UNAUTHORIZED: re-authenticating does not widen a token's scope, so telling
      // the caller to sign in again cannot help.
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Your API key does not have the required scope for this action',
      });

    // Checked here as well as in the moderator app's form action, so every caller of this endpoint
    // is held to the same grant.
    if (!(await hasModeratorGrant(ctx.actor, 'user.deleteAccount')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Deleting an account needs the "user.deleteAccount" moderator permission.',
      });

    // 🔴 THE CONFIRMATION IS ACCEPTED FROM THE BODY ONLY, and a query-string copy is refused.
    // `collectInput` lets the query string win over the body, so without this `?username=` would
    // work. Refused rather than documented: a rule a caller can break by accident is not a rule.
    if (typeof ctx.req.query.username !== 'undefined')
      throw throwBadRequestError('Send `username` in the request body, not the query string.');

    // dbWrite, not dbRead: an account deleted moments ago may not have reached the replica, and the
    // already-deleted guard below is what stops a sequential retry re-running the scrub. It is a
    // prior read, not a predicate on the write, so it does not serialise concurrent calls.
    const target = await dbWrite.user.findFirst({
      where: { id: input.userId },
      select: { id: true, username: true, deletedAt: true },
    });
    if (!target) throw throwNotFoundError(`No user with id ${input.userId}`);
    // 🔴 ORDERING IS LOAD-BEARING: already-deleted is resolved BEFORE the username match. A retry
    // after a deletion that reported failure arrives against a scrubbed row whose username is null,
    // so a username check first would answer "wrong username" about the account the operator just
    // correctly deleted. Pinned by the retry case in `delete.test.ts`.
    if (target.deletedAt)
      throw throwBadRequestError(`User ${input.userId} is already deleted; nothing to delete.`);
    // 🔴 REQUIRED WHERE IT IS CHECKABLE, NOT MERELY ACCEPTED. A mistyped id that lands on another
    // LIVE account is the one mistake nothing downstream catches — not the unknown-id refusal above,
    // not the already-deleted one — so confirmation cannot be something a caller may quietly omit.
    //
    // Keyed on the row HAVING a username rather than on "not deleted": measured on prod 2026-09-21,
    // 8,069 live accounts carry a NULL username. Demanding confirmation from them would make every
    // one permanently undeletable through this route, as a 400 on exactly the odd accounts this
    // endpoint exists for. Do not simplify this to `!target.deletedAt`.
    if (target.username !== null && input.username === undefined)
      // 🔴 THE MESSAGE MUST NOT NAME THE ACCOUNT. A confirmation that hands back the value it is
      // asking you to prove you know is not a confirmation — it is the same one-call deletion in two
      // calls. The operator this guard exists for typed a NUMBER, so they have no independent
      // expectation of the name to be surprised by: told it, they paste it back and erase the wrong
      // live account, with both calls audited as deliberate. The mismatch refusal below already gets
      // this right; keep them consistent.
      throw throwBadRequestError(
        `Send \`username\` to confirm which account is being deleted — look it up before retrying.`
      );
    // Both sides trimmed: the schema trims the confirmation, and some stored usernames end in a
    // character `trim` strips, which an exact compare could never confirm.
    if (input.username !== undefined && input.username !== target.username?.trim())
      // No name in the text, for the same reason the refusal above carries none — and for one more:
      // the framework writes a throw's message into the audit row's `errorMsg`, which `auditExclude`
      // structurally cannot reach. Quoting the value back tells the operator nothing they did not
      // just type, and keeps the one channel that could reintroduce it closed.
      throw throwBadRequestError(
        `That username does not belong to user ${input.userId}. Check the id and try again.`
      );

    await deleteUser({
      id: input.userId,
      // The STORED value, not the trimmed confirmation: `deleteUser` matches on it exactly.
      username: target.username ?? undefined,
      removeModels: input.removeModels,
      removeImages: input.removeImages,
    });

    // 🔴 THE SPOKE DELIBERATELY DOES NOT LOG THIS ONE — see `deleteAccount` in
    // `apps/moderator/src/lib/server/user-actions.service.ts`. Most `defineModeratorEndpoint`s leave
    // their ModActivity row to the spoke, and removing this call for consistency with them would
    // silently drop the audit row for any caller that does not go through the spoke — a bearer-token
    // script, or a future second caller. Read the test named for this decision before deleting it:
    // `src/__tests__/pages/api/mod/user/delete-audit-attribution.test.ts`.
    //
    // Wrapped because the deletion above has already committed. An audit write that
    // throws must not turn a completed erasure into a 500 the operator reads as a failure — that
    // combination leaves the person erased and every record saying it did not happen, and it is what
    // sends someone to retry. The gap is reported instead, and logged.
    // 🔴 TWO try BLOCKS, NOT ONE, AND THE SPLIT IS THE POINT. `auditRecorded` speaks for the
    // ModActivity row alone. Sharing a catch with the ClickHouse event would make it report `false`
    // when that row had landed and only the event had failed — and the spoke logs that as "the row
    // failed", which invites an operator to add it by hand. ModActivity is append-only in
    // production, so that produces exactly the duplicate the whole design avoids.
    let auditRecorded = true;
    try {
      await trackModActivity(ctx.actor.id, {
        entityType: 'user',
        entityId: input.userId,
        activity: 'deleteAccount',
      });
    } catch (e) {
      auditRecorded = false;
      logToAxiom({
        type: 'error',
        name: 'mod-delete-audit-failed',
        message: (e as Error).message,
        details: { moderatorId: ctx.actor.id, targetUserId: input.userId },
      });
    }

    try {
      await ctx.tracker.userActivity({ type: 'Account closure', targetUserId: input.userId });
    } catch (e) {
      logToAxiom({
        type: 'error',
        name: 'mod-delete-activity-event-failed',
        message: (e as Error).message,
        details: { moderatorId: ctx.actor.id, targetUserId: input.userId },
      });
    }

    return {
      deleted: true,
      userId: input.userId,
      auditRecorded,
      affected: { userIds: [input.userId] },
    };
  },
});
