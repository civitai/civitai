import dayjs from '~/shared/utils/dayjs';
import { fromDisplayUTC, toDisplayUTC } from '~/utils/date-helpers';

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
 */

/** The first 00:00 UTC strictly after `now`. */
export function nextUtcMidnight(now: Date) {
  return dayjs.utc(now).add(1, 'day').startOf('day').toDate();
}

/**
 * The picker edits dates in "display UTC" space — shifted so the date the
 * operator sees is the UTC one — and `handleSubmit` reverses it. A default has to
 * live in the same space or it round-trips to the wrong day.
 */
export function defaultStartsAtValue(now: Date) {
  return toDisplayUTC(nextUtcMidnight(now));
}

/** The instant a display-space picker value resolves to once submitted. */
export function resolveDisplayStart(value: Date) {
  return dayjs.utc(fromDisplayUTC(value)).startOf('day').toDate();
}

/**
 * Warns when saving would switch the event on mid-UTC-day. Returns the reason, or
 * null when the save is safe.
 */
export function lateEnableWarning({
  enabled,
  startsAt,
  now,
}: {
  enabled: boolean;
  startsAt?: Date | null;
  now: Date;
}) {
  if (!enabled) return null;
  if (!startsAt)
    return 'This event has no start date, so saving turns it on immediately. Rewards already claimed today keep the lower cap until 00:00 UTC.';
  if (resolveDisplayStart(startsAt).getTime() <= now.getTime())
    return 'This start date has already passed, so saving turns the event on immediately. Rewards already claimed today keep the lower cap until 00:00 UTC.';
  return null;
}
