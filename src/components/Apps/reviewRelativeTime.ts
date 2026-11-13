import { useEffect, useState } from 'react';

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

/**
 * How often a relative age on a moderator review surface re-renders.
 *
 * 🔴 A MINUTE IS THE FLOOR THAT MATTERS, not a guess: it is the finest granularity
 * `compactRelativeTime` can express past its `now` rung, so a faster tick could not change a
 * single label.
 */
export const REVIEW_RELATIVE_TICK_MS = 60_000;

/**
 * A `Date` that advances on an interval — the clock behind every relative age on these
 * surfaces.
 *
 * 🔴 ONE HOOK, NOT ONE PER SURFACE. It was written three times (the queue list, the shared
 * review body, and the page body — the last of which imported the TICK CONSTANT from one
 * sibling and then re-implemented the four-line body anyway). The tick is the thing a
 * reviewer tunes — a `useIsClient` gate for SSR, pausing on a hidden tab,
 * `document.visibilityState` — and three copies means tuning it once fixes one surface.
 *
 * 🔴 IT LIVES BESIDE `compactRelativeTime` ON PURPOSE. That function's docstring records
 * that a SECOND relative-age ladder in this directory was deleted for drifting; the clock
 * that drives it belongs in the same file for the same reason.
 *
 * ⚠️ NO `useIsClient` GATE. `UnifiedReviewList` argued it did not need one because nothing
 * there renders on the server — an argument that is NOT true of a page body. It is still
 * safe: `useState`'s initialiser runs identically on both sides and `setInterval` lives in an
 * effect, so SSR and the first client paint agree and only the SECOND paint moves. Stated
 * here rather than inherited silently.
 */
export function useNowTick(intervalMs: number = REVIEW_RELATIVE_TICK_MS): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

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
