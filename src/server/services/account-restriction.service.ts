import { TRPCError } from '@trpc/server';
import { RESTRICTED_ACCOUNT_MESSAGE } from '~/server/common/content-restriction';
import { couldAwaitTosReacceptance } from '~/server/common/tos-reacceptance';
import { getAccountStanding } from '~/server/services/account-standing.service';
import { shouldOfferTosReacceptance } from '~/server/services/tos-reacceptance.service';

/** What the ToS prefilter reads off a session; see `couldAwaitTosReacceptance`. */
type SessionMuteState = { mutedAt?: Date | string | null };

/**
 * The refusal for a muted account, carrying `tosReacceptRequired` when re-accepting the Terms would
 * lift the mute. Shared by `guardedProcedure`'s mute check and comic generation, so both offer the
 * same way out.
 */
export async function mutedAccountRefusal(
  userId: number,
  session: SessionMuteState
): Promise<TRPCError> {
  // `.catch`: this decides whether to OFFER a way out, never whether to refuse. A replica blip
  // rejecting here would turn the refusal into a 500 carrying the driver's message.
  const offer = couldAwaitTosReacceptance({ mutedAt: session.mutedAt, muted: true })
    ? await shouldOfferTosReacceptance(userId).catch(() => false)
    : false;
  return new TRPCError({
    code: 'FORBIDDEN',
    message: RESTRICTED_ACCOUNT_MESSAGE,
    ...(offer ? { cause: { tosReacceptRequired: true } } : {}),
  });
}

/**
 * Refuses a restricted account, for paths that act for a user without a fresh session (a block
 * token's subject, a credential mint) or that skip `guardedProcedure` (comic generation). Reads the
 * stored standing through its cache, which every mute, unmute, ban and unban busts, so a restriction
 * applied moments ago is seen. A missing row refuses too, and so does a failed read.
 *
 * A change written to `User` outside the app's mute and ban paths busts nothing, so it is seen once
 * the cached entry ages out: within `ACCOUNT_STANDING_TTL` (60 s), at most twice that.
 *
 * Pass `session` when the caller has the user's session: a muted account is then offered the Terms
 * where that would lift the mute. A banned or missing account never is.
 */
export async function assertAccountNotRestricted(
  userId: number,
  session?: SessionMuteState
): Promise<void> {
  const standing = await getAccountStanding(userId);
  if (standing.exists && !standing.banned && standing.muted && session)
    throw await mutedAccountRefusal(userId, session);
  if (!standing.exists || standing.muted || standing.banned) {
    throw new TRPCError({ code: 'FORBIDDEN', message: RESTRICTED_ACCOUNT_MESSAGE });
  }
}
