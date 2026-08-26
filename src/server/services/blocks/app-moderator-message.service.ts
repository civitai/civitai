import { TRPCError } from '@trpc/server';

import { dbWrite } from '~/server/db/client';
import { throwOnBlockedLinkDomain } from '~/server/services/blocklist.service';
import {
  listAcceptedCollaboratorUserIds,
  resolveListingAccess,
} from '~/server/services/blocks/app-access.service';
import { notifyAppModeratorMessage } from '~/server/services/blocks/app-moderator-message-notify';
import {
  MOD_MESSAGE_BODY_MAX,
  MOD_MESSAGE_BODY_MIN,
  MOD_MESSAGE_SUBJECT_MAX,
  MOD_MESSAGE_SUBJECT_MIN,
  type MessageAppOwnerInput,
} from '~/server/schema/blocks/app-moderator-message.schema';
import {
  checkModMessageListingQuota,
  checkModMessageModeratorQuota,
} from '~/server/utils/app-moderator-message-rate-limit';
import { newAppListingModerationEventId } from '~/server/utils/app-block-ids';

/**
 * MODERATOR → APP-DEVELOPER MESSAGING.
 *
 * ## The gap this closes
 *
 * The platform already notifies app owners eleven ways (`app-block-*`,
 * `app-listing-*`, `app-collaborator-*`, `app-ownership-transfer-*`). Every one is
 * EVENT-TRIGGERED with copy the platform wrote — four of them splice in a moderator's
 * `reason`, but the moderator never chooses the SUBJECT. So a moderator who needs to
 * say something the platform has no event for — "your listing says it estimates the
 * cost and asks before it spends; it has never done that" — has had two options: push
 * a change to someone else's app, or find the developer off-platform. This is the
 * third: a mod-only, free-text, one-way message that lands in the existing
 * notification substrate as a twelfth type.
 *
 * ## What it deliberately is NOT
 *
 * Not an inbox, not a thread, no reply route, no read receipts, no message table. The
 * notification IS the delivery, and the rendered copy says replies are not delivered
 * (see `app-moderator-message.notifications.ts`). Everything durable about the send
 * lives in the audit event, which is a table that already exists.
 *
 * ## Ordering, and why it is the order it is
 *
 * 1. RESOLVE the listing + its CANONICAL owner (read).
 * 2. VALIDATE the text (bounds re-check + blocked-link scan).
 * 3. SPEND the rate-limit budget.
 * 4. WRITE the audit event.
 * 5. DELIVER, best-effort, post-write.
 *
 * The write precedes the delivery so that a notifications outage costs the delivery
 * and never the record that a moderator sent a message — the inverse would let a mod
 * message a developer with nothing in the audit log.
 *
 * 🔴 ONE ORDERING PRINCIPLE, APPLIED IN THREE PLACES: a send that will not happen must
 * never consume the RECIPIENT's budget. So the text validation precedes the quota spend
 * (a mod fixing a typo would otherwise burn the listing's hourly allowance), and the
 * ACTOR window is spent and checked before the LISTING window is touched at all. Step 3
 * is therefore two steps, not one — see the note at the call site.
 *
 * ⚠️ SCOPE OF "nothing is delivered that is not first recorded": it is a property of
 * THIS procedure, not of the `app-moderator-message` notification type. The
 * webhook-token-gated `src/pages/api/mod/send-mod-notification.ts` can emit any type —
 * this one included — with arbitrary `userIds` and text, no audit row and no rate limit.
 * That is not moderator-reachable and is equally true of the eleven existing app types,
 * but the claim above is about the proc.
 *
 * ## Authorization
 *
 * Enforced at the router (`moderatorProcedure` + the inner `isModerator` recheck —
 * the house idiom for every mod action in `app-listings.router.ts`). This service does
 * NOT re-derive it: `moderatorUserId` is bound from `ctx.user.id` and is never
 * client-supplied, exactly as `reviewerUserId` is on delist/relist/claim/purge. The
 * negative-per-role matrix is pinned in
 * `app-listings.router.mod-actions-authz.test.ts` and asserts the service is NOT
 * called, not merely that the call threw.
 */

/** Typed failure modes. Duck-typed by the router's `mapOffsiteError` via `name`. */
export type AppModeratorMessageErrorCode =
  //   NOT_FOUND    — no such listing → NOT_FOUND.
  //   BLOCKED_LINK — the text carries a blocked link domain → BAD_REQUEST.
  //   INVALID_TEXT — bounds re-check failed below the schema → BAD_REQUEST.
  //   RATE_LIMITED — a fixed window is exhausted → TOO_MANY_REQUESTS.
  'NOT_FOUND' | 'BLOCKED_LINK' | 'INVALID_TEXT' | 'RATE_LIMITED';

export class AppModeratorMessageError extends Error {
  readonly code: AppModeratorMessageErrorCode;
  constructor(code: AppModeratorMessageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AppModeratorMessageError';
    this.code = code;
  }
}

export type MessageAppOwnerResult = {
  /** The PARENT listing the message was recorded against. */
  appListingId: string;
  /** The audit event id (`alme_<ULID>`) — also the notification's idempotency key. */
  eventId: string;
  /** How many users the message was delivered to. */
  recipientCount: number;
};

/**
 * 🔴 CONTENT SAFETY: `assertSharedTextSafe` IS DELIBERATELY NOT APPLIED HERE, and the
 * reasoning is worth reading before "fixing" this.
 *
 * That belt exists for App Blocks SHARED storage — untrusted, cross-user, PUBLIC text
 * rendered in other users' browsers. Three of its five checks are actively wrong for
 * this surface:
 *
 *   - `includesMinor` / `includesPoi` HARD-FAIL the text, with NO moderator bypass —
 *     they run before the `isModerator` flag reaches anything. A moderator writing
 *     "your cover image appears to depict a minor — take it down" is exactly the
 *     message this channel exists to carry, and that belt refuses to send it. The
 *     control would block its own most important use. This leg alone is sufficient.
 *   - `auditPromptServer({ isGreen: true })` forces the SFW + profanity ceiling on
 *     correspondence between staff and a developer, and on a hit appends
 *     `GREEN_SFW_REDIRECT` — "please visit civitai.red where you have more freedom to
 *     generate mature content" — which is nonsense copy to show a moderator writing to
 *     a developer about their app.
 *     ⚠️ CORRECTED: an earlier version of this comment claimed the audit accrues
 *     blocked-prompt strikes against the SENDER. It does NOT. With `isGreen: true` the
 *     handler takes the `else if (isGreen)` branch (`promptAuditing.ts`), which calls
 *     neither `addBlockedPrompt` nor `reportProhibitedRequest` — no strike, no
 *     ClickHouse row, no auto-mute; and `assertSharedTextSafe` threads `isModerator`
 *     through anyway. The real cost is the hard-failed send and the wrong copy above,
 *     which is narrower than what this comment used to assert. Left visible rather than
 *     silently rewritten, because the overstated version was quoted in review.
 *
 * It would also be inconsistent rather than protective: EVERY existing moderator
 * free-text field that renders verbatim into a user-visible notification —
 * `delistListing.reason` → `app-listing-hidden`, `rejectRequest.reason` →
 * `app-block-rejected`, `tos-violation.reason` — runs no content safety at all. A belt
 * on this one path and none on those four is a spelled control, not a real one.
 *
 * 🔴 WHAT DOES APPLY, and is kept: the LINK check. Moderator status establishes that
 * the sender is trusted staff; it does not survive a COMPROMISED mod session, and the
 * one thing such a session can do through this channel that mod-status does not
 * mitigate is put a hostile URL in front of a developer, carrying the platform's own
 * "Civitai moderation sent you a message" framing. `throwOnBlockedLinkDomain` is the
 * platform's existing answer to that and costs one cached Redis read. Plus the bounds
 * below, re-asserted independent of the zod schema so a future second caller cannot
 * skip the ceiling.
 */
async function validateMessageText(subject: string, body: string): Promise<void> {
  if (subject.length < MOD_MESSAGE_SUBJECT_MIN || subject.length > MOD_MESSAGE_SUBJECT_MAX) {
    throw new AppModeratorMessageError(
      'INVALID_TEXT',
      `subject must be between ${MOD_MESSAGE_SUBJECT_MIN} and ${MOD_MESSAGE_SUBJECT_MAX} characters`
    );
  }
  if (body.length < MOD_MESSAGE_BODY_MIN || body.length > MOD_MESSAGE_BODY_MAX) {
    throw new AppModeratorMessageError(
      'INVALID_TEXT',
      `body must be between ${MOD_MESSAGE_BODY_MIN} and ${MOD_MESSAGE_BODY_MAX} characters`
    );
  }
  try {
    await throwOnBlockedLinkDomain(`${subject}\n${body}`);
  } catch (err) {
    // 🔴 NARROW ON PURPOSE — a bare `catch` here is a live defect, not a style nit.
    //
    // `throwOnBlockedLinkDomain` reaches `getBlocklistDTO`, whose FIRST statement is an
    // unguarded `await redis.get(...)`. So a Redis outage throws from inside this call,
    // and a bare catch converts it into "The message contains a blocked link domain."
    // about a message that contains no link — leaving the moderator to edit text that
    // is fine, with no way to tell. Worse, `BLOCKED_LINK` maps to BAD_REQUEST, which
    // never reaches the INTERNAL branch that feeds the server-fault logger, so the
    // outage would be INVISIBLE from this path.
    //
    // 🔴 It would also invert this feature's own stated fail-direction: the rate limiter
    // deliberately fails OPEN so a Redis incident cannot block moderation
    // correspondence (see `app-moderator-message-rate-limit.ts`). A fail-CLOSED Redis
    // dependency in front of the same send contradicts that.
    //
    // `throwOnBlockedLinkDomain` signals a REAL block with `throwBadRequestError`, i.e.
    // a `TRPCError` with code BAD_REQUEST. Anything else — a Redis error, a JSON parse
    // failure on a corrupt cache entry, a DB error in `readBlocklistRow` — is infra and
    // is RETHROWN, so the router maps it to INTERNAL_SERVER_ERROR (no raw leak) and it
    // is logged as the fault it is.
    //
    // ⚠️ `assertSharedTextSafe` has the byte-identical wart (its `catch {}` around the
    // same call re-labels everything as `'link'`). This is a copied house pattern rather
    // than a novel defect here; fixing it there is a separate change.
    if (err instanceof TRPCError && err.code === 'BAD_REQUEST') {
      throw new AppModeratorMessageError(
        'BLOCKED_LINK',
        'The message contains a blocked link domain.',
        { cause: err }
      );
    }
    throw err;
  }
}

/**
 * Send one moderator-authored message to an app's owner (and, on request, its accepted
 * collaborators).
 *
 * 🔴 THE RECIPIENT IS THE CANONICAL OWNER, RESOLVED BY `resolveListingAccess` —
 * NEVER the `AppListing.userId` column. For an ON-SITE listing that column is a
 * DENORMALIZED COPY of `AppBlock.app.userId` and is stale-able: `beginListingRevision`
 * freezes it at clone time, and no ownership write revisits the clone. On a drifted
 * row, reading the copy sends a moderator's private message about someone's app to a
 * user who no longer owns it — a disclosure, not merely a missed delivery — while the
 * real owner is never told their listing has a problem. `resolveListingAccess` is the
 * one place the kind branch is written (onsite → the block's `OauthClient.userId` with
 * the column as fallback; offsite → the column unconditionally, issue #3844), and it
 * hops a shadow revision to its parent, which is what makes `seatListingId` and `slug`
 * below the PARENT's rather than a synthetic `rev-<ulid>`'s.
 *
 * 🔴 It is called with `userId: null`. This resolver's second argument asks "what is
 * THIS caller's role", and the caller here is a MODERATOR who is not a party to the
 * app. Passing the moderator's id would compute a role nobody reads AND cost the seat
 * lookup; passing null takes the `typeof userId !== 'number'` early return, so the
 * owner is resolved in exactly one query.
 */
export async function messageAppOwner(opts: {
  input: MessageAppOwnerInput;
  /** Bound from `ctx.user.id` at the router. NEVER client-supplied. */
  moderatorUserId: number;
}): Promise<MessageAppOwnerResult> {
  const { input, moderatorUserId } = opts;
  const subject = input.subject.trim();
  const body = input.body.trim();

  const access = await resolveListingAccess(input.appListingId, null);
  if (!access) {
    throw new AppModeratorMessageError('NOT_FOUND', 'Listing not found.');
  }
  // The PARENT listing: what a seat, a quota and an audit row are all keyed on. A mod
  // who pasted a shadow revision id gets the same behaviour as one who pasted the
  // listing id, rather than a second quota allowance and an orphaned audit row.
  const appListingId = access.seatListingId;

  // Trimmed, so a body of 30 spaces cannot satisfy the schema's `min` and arrive as an
  // empty message. Runs BEFORE the quota spend — see the ordering note in the header.
  await validateMessageText(subject, body);

  // 🔴 THE ACTOR WINDOW IS SPENT AND CHECKED FIRST, AND THE LISTING WINDOW IS NOT
  // TOUCHED WHEN THE ACTOR IS ALREADY CAPPED. Spending both unconditionally is a live
  // defect, and it is the SAME ordering principle the text validation above obeys: a
  // send that will not happen must not consume the RECIPIENT's budget.
  //
  // The concrete harm, because it is not obvious: the listing window is the harassment
  // ceiling, 5/h across ALL moderators. A moderator who has exhausted their own 30/h
  // window and keeps retrying would INCR the per-listing key on every attempt — five
  // retries by one already-capped mod would exhaust that app's ceiling and LOCK OUT
  // every other moderator for the rest of the hour, over messages that were never sent.
  //
  // 🔴 The short-circuit runs in ONE direction only. Skipping the listing spend when the
  // actor is REFUSED is free (nothing is delivered, so nothing should count against the
  // recipient). Skipping it when the actor is ALLOWED would be the opposite mistake and
  // would leave the ceiling unenforced for every mod under their own cap — i.e. the
  // normal case. `app-moderator-message.service.test.ts` pins both directions.
  const actorQuota = await checkModMessageModeratorQuota(moderatorUserId);
  if (!actorQuota.allowed) {
    throw new AppModeratorMessageError(
      'RATE_LIMITED',
      `Too many moderator messages — try again in ${actorQuota.retryAfterSeconds}s.`
    );
  }
  const listingQuota = await checkModMessageListingQuota(appListingId);
  if (!listingQuota.allowed) {
    throw new AppModeratorMessageError(
      'RATE_LIMITED',
      `Too many moderator messages — try again in ${listingQuota.retryAfterSeconds}s.`
    );
  }

  const recipients = new Set<number>([access.ownerUserId]);
  if (input.includeCollaborators) {
    for (const userId of await listAcceptedCollaboratorUserIds(appListingId)) {
      recipients.add(userId);
    }
  }
  // A `Set` rather than an array: the owner can also hold a seat row on their own
  // listing (nothing forbids it), and a duplicated recipient would be a second
  // notification of the same message.
  const recipientUserIds = [...recipients];

  // 🔴 THE AUDIT ROW IS WRITTEN BEFORE ANYTHING IS DELIVERED. `reason` carries the
  // subject and `detail` the body, so the moderation history renders the message a
  // moderator actually sent rather than the fact that one was sent — which is the only
  // form in which this channel can be reviewed after the fact. `actorUserId` is the
  // durable attribution the RECIPIENT is deliberately not given (see the notification
  // module's header). A single `create`, so no transaction: there is nothing to keep
  // consistent with it.
  const eventId = newAppListingModerationEventId();
  await dbWrite.appListingModerationEvent.create({
    data: {
      id: eventId,
      appListingId,
      slug: access.slug,
      action: 'message-owner',
      actorUserId: moderatorUserId,
      reason: subject,
      detail: body,
      // No state changed, so there is no `before`. `after` records the DELIVERY
      // decision, which is the part a later reviewer cannot reconstruct: whether the
      // collaborators were looped in, and who the owner resolved to at send time.
      after: { recipientUserIds, includeCollaborators: !!input.includeCollaborators },
    },
  });

  // Post-write, best-effort. `createNotification` swallows client errors itself, and
  // the caller wraps this too, so a notifications outage can never fail a send that is
  // already recorded.
  await notifyAppModeratorMessage({
    userIds: recipientUserIds,
    // Keyed by the audit event id, so a retried request delivers once (mirrors
    // `app-listing-hidden:${eventId}`) without needing a nonce.
    key: `app-moderator-message:${eventId}`,
    details: { slug: access.slug, listingId: appListingId, subject, body },
  });

  return { appListingId, eventId, recipientCount: recipientUserIds.length };
}
