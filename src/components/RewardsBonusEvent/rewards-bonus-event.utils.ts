import { endOfDay, startOfDay } from '~/utils/date-helpers';

/**
 * `startsAt` is a gate, not a trigger. `getActiveRewardsBonusEvent` requires
 * `enabled` AND the window, and `enabled` is a checkbox with no schedule — so an
 * event enabled by hand goes live at the moment of the click regardless of the
 * start date it carries.
 *
 * That matters because every reward's daily cap multiplies by the event, while
 * the Redis hash the caps are enforced against only resets at 00:00 UTC. A user
 * who already claimed a once-per-day reward under the lower cap cannot claim the
 * difference, so activating part-way through a UTC day strands everyone who
 * claimed earlier in it. On 2026-08-19 that was 17,843 daily-boost claimers.
 *
 * These helpers only steer the operator toward an aligned start. The reward-side
 * defect — ClickUp 868m16pdp, a once-per-day reward cannot claim the top-up to a
 * cap that rose mid-day — is still open, and nothing here fixes it.
 */

/** The first 00:00 UTC strictly after `now`. */
export function nextUtcMidnight(now: Date) {
  const tomorrow = new Date(now.getTime());
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return startOfDay(tomorrow, { utc: true });
}

/**
 * The date pickers hold a LOCAL date whose calendar day is read as the UTC one.
 *
 * 🔴 Convert by calendar fields, never by `toDisplayUTC`/`fromDisplayUTC`. Those
 * shift by `getTimezoneOffset()` taken at two different instants, so they are not
 * inverses across a DST boundary — and against a 00:00 UTC target an hour of slip
 * is a whole day. Measured with real `Intl` offsets: Australia/Sydney turns
 * 2026-10-04 into 2026-10-03, Pacific/Auckland 2026-09-27 into 2026-09-26,
 * America/Santiago 2026-04-05 into 2026-04-04, Asia/Beirut 2026-03-29 into
 * 2026-03-28. Zones transitioning at 02:00 local (the US ones) never show it,
 * which is why it survives a US-only reading. Reading the fields cannot slip:
 * a skipped local midnight still reports the day the operator picked.
 */
export function toDisplayDate(instant: Date) {
  return new Date(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate());
}

/** The instant a display-space picker value resolves to once submitted. */
export function resolveDisplayStart(value: Date) {
  return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
}

/** As `resolveDisplayStart`, but the far end of the same UTC day. */
export function resolveDisplayEnd(value: Date) {
  return endOfDay(resolveDisplayStart(value), { utc: true });
}

/**
 * What the start picker opens on. A create gets the next UTC midnight so that
 * ticking Enabled straight away is already safe; an existing event keeps whatever
 * it has, INCLUDING nothing.
 *
 * 🔴 The three arms are not two. Collapsing the middle one injects a start date
 * into an event saved without one — event id 1 is enabled with a null start — and
 * a moderator opening it to fix a typo would reschedule a live event having typed
 * nothing.
 */
export function initialStartsAtValue({
  event,
  now,
}: {
  event?: { id?: number; startsAt?: Date | null };
  now: Date;
}) {
  if (event?.startsAt) return toDisplayDate(event.startsAt);
  if (event?.id) return undefined;
  return toDisplayDate(nextUtcMidnight(now));
}

type ActivationState = {
  enabled: boolean;
  startsAt?: Date | null;
  endsAt?: Date | null;
};

/** Whether `getActiveRewardsBonusEvent` would pick this state up right now. */
function isLive(state: ActivationState, now: Date) {
  if (!state.enabled) return false;
  if (state.startsAt && state.startsAt.getTime() > now.getTime()) return false;
  if (state.endsAt && state.endsAt.getTime() < now.getTime()) return false;
  return true;
}

/**
 * Warns when saving would switch the event on part-way through a UTC day.
 *
 * 🔴 Scoped to the TRANSITION, not to the resting state. Warning whenever a live
 * event merely looks live fires on every edit of every running event — a banner
 * label typo included — and the operators who see that are the same handful the
 * warning exists to reach. An advisory control that cries wolf on the common path
 * has already stopped working on the rare one.
 *
 * Both states are INSTANTS. Resolve display-space picker values before calling.
 */
export function lateEnableWarning({
  next,
  previous,
  now,
}: {
  next: ActivationState;
  previous?: ActivationState;
  now: Date;
}) {
  if (!isLive(next, now)) return null;
  if (previous && isLive(previous, now)) return null;

  return next.startsAt
    ? 'This start date has already passed, so saving turns the event on now. Rewards already claimed today keep the lower cap until 00:00 UTC.'
    : 'This event has no start date, so saving turns it on now. Rewards already claimed today keep the lower cap until 00:00 UTC.';
}
