/**
 * Compact relative age for the moderator review surfaces.
 *
 * `now` is a parameter, not a `Date.now()` read, so every rung is reachable without faking
 * timers.
 *
 * THE ONLY relative-age ladder under `~/components/Apps`. `ActivePreviewsPanel.formatAge`
 * was a second one in this directory for the same job — it stopped at days (`12d` where this
 * reads `1w`), said `just now` for the sub-minute rung, and read the clock itself, which is
 * why it needed faked timers to test. It now delegates here via `compactRelativeAgeOf` and
 * its ladder is deleted. Not `DaysFromNow`: that renders dayjs's long phrase, which is the
 * width these columns exist to give back.
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

/**
 * `compactRelativeTime` for a caller holding a NULLABLE or string timestamp.
 *
 * Absence is the one thing the ladder itself cannot express — it takes a `Date`, and
 * `new Date(null)` is the epoch, which would render `56y` instead of "no value". So the
 * null/undefined/empty check lives here, returning the same em dash the deleted `formatAge`
 * returned for those inputs.
 *
 * `now` stays injectable and only defaults to the clock, so the fold is testable without
 * faking timers. Prefer the two-argument `compactRelativeTime` where the caller already
 * holds a `Date`.
 */
export function compactRelativeAgeOf(
  d: string | Date | null | undefined,
  now: Date = new Date()
): string {
  if (!d) return UNKNOWN;
  return compactRelativeTime(typeof d === 'string' ? new Date(d) : d, now);
}
