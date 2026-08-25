import { INDEFINITE_MUTE_POINTS, TIMED_MUTE_POINTS } from '~/shared/constants/strike.constants';

/**
 * The ToS re-acceptance gate: a user muted by the strike system is asked to re-read and accept the
 * terms at the moment they try to do something the mute blocks, rather than being told only that they
 * are "restricted".
 *
 * Shared by the tRPC mute guard (which raises it) and the client (which opens the ToS modal on it), so
 * the marker has exactly one spelling.
 */

/** Section of the ToS a struck user is sent to. Every canned strike reason cites this one. */
export const TOS_REACCEPTANCE_SECTION = 'tos-prohibited-content';

/**
 * Stamped on `meta.muteReason` when strike escalation mutes an account. The scam auto-mute and the
 * generation-restriction mute also leave `mutedAt` null, so without this the gate would offer the
 * Terms — and release on acceptance — to accounts muted for something else entirely.
 */
export const STRIKE_MUTE_REASON = 'strike-escalation';

type MuteState = { muted?: boolean | null; mutedAt?: Date | string | null };

/**
 * Cheap first pass, from the session alone: could this mute possibly be one the gate covers?
 *
 * `mutedAt` set means a moderator decided it, and a person's mute is never liftable by ticking a box.
 * Everything else needs the account's reason and point total, which the session does not carry — see
 * `tosReacceptanceOffer`.
 */
export function couldAwaitTosReacceptance(user: MuteState | null | undefined): boolean {
  return !!user?.muted && user.mutedAt == null;
}

/**
 * Whether to offer the Terms to this muted account, given what only the database knows.
 *
 * Two points exactly. At three the account is queued for a moderator to decide on a ban, and there is
 * nothing for the user to do — showing them a document they can accept to no effect would be worse
 * than the plain refusal.
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
  return activePoints >= TIMED_MUTE_POINTS && activePoints < INDEFINITE_MUTE_POINTS;
}

/** Per-domain acceptance timestamps written by the ToS accept flow. */
const TOS_SEEN_FIELDS = ['tosLastSeenDate', 'tosGreenLastSeenDate', 'tosRedLastSeenDate'] as const;

/**
 * Has this account accepted the Terms since it was last struck?
 *
 * This is what holds — and releases — the 2-point mute, in place of a new column: the accept flow
 * already records a timestamp, and every strike already has a `createdAt`. A NEW strike is therefore
 * newer than any prior acceptance, which re-arms the gate with no bookkeeping of its own.
 *
 * The MAX across domains, not the domain that issued the strike: strikes are platform-wide while the
 * Terms are per-domain, and trapping a green-domain user because they accepted the wrong document is
 * the worse failure.
 */
export function acceptedTosSinceLastStrike(
  settings: Record<string, unknown> | null | undefined,
  lastStrikeAt: Date | null | undefined
): boolean {
  // Never struck: nothing to accept for.
  if (!lastStrikeAt) return true;

  const accepted = TOS_SEEN_FIELDS.map((f) => settings?.[f])
    .map((v) => (typeof v === 'string' || v instanceof Date ? new Date(v) : null))
    .filter((d): d is Date => d != null && !Number.isNaN(d.getTime()));

  if (!accepted.length) return false;
  return Math.max(...accepted.map((d) => d.getTime())) > lastStrikeAt.getTime();
}
