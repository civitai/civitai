/**
 * Compact relative age for the moderator review queue.
 *
 * `now` is a parameter, not a `Date.now()` read, so every rung is reachable without faking
 * timers.
 *
 * Not `formatAge` (`~/components/Apps/ActivePreviewsPanel`): that ladder stops at days and
 * reads the clock itself. Not `DaysFromNow`: it renders dayjs's long phrase, which is the
 * width this column exists to give back.
 */

/** A timestamp we cannot read at all (an unparseable string reaching the adapter). */
const UNKNOWN = '—';

export function compactRelativeTime(date: Date, now: Date): string {
  const then = date.getTime();
  const nowMs = now.getTime();
  if (!Number.isFinite(then) || !Number.isFinite(nowMs)) return UNKNOWN;

  // A FUTURE timestamp reads `now`, not a negative age. Submission times come from the
  // database and `now` from the browser, so a few seconds of skew between them is ordinary;
  // `—` would make that look like missing data.
  const seconds = Math.max(0, Math.floor((nowMs - then) / 1000));
  if (seconds < 60) return 'now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;

  // Years win over months, and months clamp to 11: without the clamp the 360..364 day band
  // reads `12mo`, the one label a reader has to convert.
  const years = Math.floor(days / 365);
  if (years >= 1) return `${years}y`;
  return `${Math.min(11, Math.floor(days / 30))}mo`;
}
