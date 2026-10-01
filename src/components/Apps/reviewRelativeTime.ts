/**
 * Compact relative age for the moderator review queue — `now`, `42m`, `5h`, `3w`, `2mo`, `1y`.
 *
 * `now` is a PARAMETER rather than a `Date.now()` read, so every rung of the ladder is
 * reachable from a test without faking timers. The renderer injects it.
 *
 * Deliberately NOT `formatAge` in `~/components/Apps/ActivePreviewsPanel`: that ladder stops
 * at days (a review preview lives minutes) and reads the clock itself, so it cannot express a
 * queue entry that is weeks old. Deliberately not `DaysFromNow` either — that renders dayjs's
 * long phrase ("3 months ago"), which is the width this column exists to give back.
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

  // Years take precedence over months, then months are clamped to 11 — otherwise the 335..364
  // day band reads `12mo` while 365 reads `1y`, and `12mo` is the one label a reader has to
  // convert. Clamping keeps the ladder monotonic without a second threshold to keep in step.
  const years = Math.floor(days / 365);
  if (years >= 1) return `${years}y`;
  return `${Math.min(11, Math.floor(days / 30))}mo`;
}
