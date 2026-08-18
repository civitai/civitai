/**
 * The day comic view tracking went live.
 *
 * Comic views before this date do not exist as `views` rows — they are reconstructed from
 * `pageViews` paths by the comic view backfill (civitai-scripts, `backfill/comic-views.js`), which
 * writes straight into `daily_views`. The reconstruction is close but not identical, and one difference is visible to
 * anyone reading a chart:
 *
 *   Chapter reads are gated on `canRead`, so a paywalled early-access chapter a viewer could not
 *   open is not a read. `pageViews` cannot see that gate, so backfilled chapter counts include
 *   those locked hits. For a comic that sells early access, the chapter series STEPS DOWN on this
 *   date — permanently — and reads as the comic losing readers the day the feature shipped.
 *
 * Anything charting comic views should draw the span before this date differently and say why,
 * rather than presenting one continuous series.
 *
 * NOT exclusive — this day is MIXED, see below.
 *
 * It is OBSERVED, not chosen. The backfill (civitai-scripts, `backfill/comic-views.js`) takes no
 * date argument at all: it finds the first day whose beacon count clears a volume floor, reads
 * `min(time)` of that day's beacons, and backfills up to that exact TIMESTAMP. A date boundary has
 * no correct value, because tracking starts mid-day — stop at the cutover day and its pre-deploy
 * views are written by nothing; stop at the next day and its post-deploy views are written twice.
 * Both fail silently, so the boundary is derived and there is no value left to typo.
 *
 * Verified 2026-08-17: tracking went live at 17:20:57 UTC and the backfill ran to that timestamp,
 * so THIS DAY IS MIXED — reconstructed for 00:00-17:20, live beacons after. Every day before it is
 * wholly reconstructed; every day after, wholly live. `daily_views` is date-granular and sums, so
 * the day's total is correct even though its two halves were measured differently.
 *
 * 🔴 KNOWN OPEN BUG as of 2026-08-17: live tracking records only ~50% of what `pageViews` sees for
 * comics (measured: project 0.48, chapter 0.54; articles and posts are at 1.06-1.08 in the same
 * window, so it is comics-specific). The reconstructed span is therefore roughly 2x the live span,
 * and a chart spanning this date shows a step DOWN that is the bug's signature, not an artifact of
 * the backfill. Do not describe that step to creators as a drop in readership. It closes when the
 * undercount is fixed, at which point the two spans line up.
 */
export const COMIC_VIEW_TRACKING_CUTOVER = '2026-08-17';

/** Human-readable reason, for a tooltip or footnote on a chart that spans the cutover. */
export const COMIC_VIEW_BACKFILL_NOTE =
  'Views before this date are reconstructed from page visits and count paywalled chapter opens, ' +
  'which live tracking excludes.';
