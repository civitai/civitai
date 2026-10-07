import { REVIEW_MUTE_POINTS, MUTE_POINTS } from '~/shared/constants/strike.constants';

/** Section of the ToS a struck user is sent to. Re-exported so the client half needs one import. */
export { TOS_PROHIBITED_CONTENT_ID as TOS_REACCEPTANCE_SECTION } from '~/components/Markdown/rehype-tos-section-ids';

/**
 * Stamped on `meta.muteReason` when strike escalation mutes an account. The scam auto-mute and the
 * generation-restriction mute also leave `mutedAt` null, so without this the gate would offer the
 * Terms to accounts muted for something else entirely.
 */
export const STRIKE_MUTE_REASON = 'strike-escalation';

type MuteState = { muted?: boolean | null; mutedAt?: Date | string | null };

/**
 * Cheap first pass, from the session alone: could this mute possibly be one the gate covers?
 *
 * `mutedAt` set means a moderator decided it, so it gets no prompt. Everything else needs the account's reason and point total, which the session does not carry — see
 * `tosReacceptanceOffer`.
 */
export function couldAwaitTosReacceptance(user: MuteState | null | undefined): boolean {
  return !!user?.muted && user.mutedAt == null;
}

/**
 * Whether to offer the Terms to this muted account, given what only the database knows. Accepting
 * records the acceptance; it never lifts the mute.
 *
 * Two points exactly. At three the account is queued for a moderator to decide on a ban.
 *
 * The reason check is what keeps the offer off a scam auto-mute or a generation restriction, which
 * also leave `mutedAt` null.
 */
export function tosReacceptanceOffer({
  muted,
  mutedAt,
  muteReason,
  activePoints,
}: {
  muted?: boolean | null;
  mutedAt?: Date | string | null;
  muteReason?: string | null;
  activePoints: number;
}): boolean {
  if (!couldAwaitTosReacceptance({ muted, mutedAt })) return false;
  if (muteReason !== STRIKE_MUTE_REASON) return false;
  return activePoints >= MUTE_POINTS && activePoints < REVIEW_MUTE_POINTS;
}
