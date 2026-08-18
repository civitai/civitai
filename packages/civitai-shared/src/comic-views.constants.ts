/**
 * Where comic view history changes measurement.
 *
 * Comic views before this point do not exist as `views` rows — they are reconstructed from
 * `pageViews` paths by the comic view backfill (civitai-scripts, `backfill/comic-views.js`), which
 * writes straight into `daily_views`.
 *
 * The boundary is a TIMESTAMP, not a date, and that is not a detail. Tracking went live mid-day, so
 * the backfill ran to the exact moment of the first beacon and no date can express it: treat
 * 2026-08-17 as reconstructed and 17 hours of live data are mislabelled; treat it as live and the
 * same 17 hours of reconstructed data are. `daily_views` is date-granular and sums, so that day's
 * TOTAL is correct — but its provenance is mixed, and a chart that colours by provenance has to say
 * so rather than pick a side.
 */
export const COMIC_VIEW_TRACKING_CUTOVER = '2026-08-17T17:20:57Z';

/**
 * The one day that is partly both: reconstructed 00:00-17:20:57 UTC, live beacons after. Every day
 * before it is wholly reconstructed; every day after, wholly live.
 */
export const COMIC_VIEW_MIXED_DAY = '2026-08-17';

/**
 * The window where live tracking was live but undercounting, and which nothing back-fills.
 *
 * Comic view tracking shipped on 2026-08-17 recording only ~50% of what `pageViews` saw — its
 * `TrackView` sat behind a slow query, so the effective threshold for a view was ~5-6s and 47% of
 * comic visits are shorter (measured: project 0.48, chapter 0.54, against 1.06-1.08 for articles
 * and posts in the same window). Fixed in PR #4066.
 *
 * 🔴 So a chart spanning this period has TWO steps, not one: down at the cutover, and back up when
 * the fix deployed, with an undercounted trough between them. The trough is permanent — the
 * backfill stops at the cutover and does not cover it. Do not describe either step to creators as
 * a change in readership.
 *
 * Set the end to the #4066 deploy date once it ships; null means the fix is not out yet.
 */
export const COMIC_VIEW_UNDERCOUNT_WINDOW: { start: string; end: string | null } = {
  start: '2026-08-17T17:20:57Z',
  end: null,
};

/** Human-readable reason, for a tooltip or footnote on a chart that spans the cutover. */
export const COMIC_VIEW_BACKFILL_NOTE =
  'Views before this date are reconstructed from page visits and count paywalled chapter opens, ' +
  'which live tracking excludes.';
