/**
 * The day comic view tracking went live.
 *
 * Comic views before this date do not exist as `views` rows — they are reconstructed from
 * `pageViews` paths by the comic view backfill (civitai-scripts, `backfill/comic-views.js`), which
 * writes straight into
 * `daily_views`. The reconstruction is close but not identical, and one difference is visible to
 * anyone reading a chart:
 *
 *   Chapter reads are gated on `canRead`, so a paywalled early-access chapter a viewer could not
 *   open is not a read. `pageViews` cannot see that gate, so backfilled chapter counts include
 *   those locked hits. For a comic that sells early access, the chapter series STEPS DOWN on this
 *   date — permanently — and reads as the comic losing readers the day the feature shipped.
 *
 * Anything charting comic views should draw the span before this date differently and say why,
 * rather than presenting one continuous series. The backfill asserts its `--until` equals this
 * value, so the two cannot drift apart.
 *
 * Exclusive: this date is the first day of live tracking, and the last backfilled day is the one
 * before it.
 *
 * It is OBSERVED, not chosen. The backfill (civitai-scripts, `backfill/comic-views.js`) refuses to
 * run until `default.views` actually holds a day of real comic views, then asserts that the first
 * such day equals this value and names the correct one if it does not — so this is a checked
 * contract rather than a date someone picked in advance.
 * A guessed date fails silently in both directions: a day early and live rows land inside the
 * backfilled window; a day late and that day gets neither backfill nor tracking. The boundary is
 * UTC midnight, which falls the previous evening in US timezones, so a hand-picked date is
 * ambiguous before a 20-30 minute deploy is even factored in.
 *
 * Placeholder until the tracking code deploys; the backfill will tell you the real value.
 */
export const COMIC_VIEW_TRACKING_CUTOVER = '2026-08-18';

/** Human-readable reason, for a tooltip or footnote on a chart that spans the cutover. */
export const COMIC_VIEW_BACKFILL_NOTE =
  'Views before this date are reconstructed from page visits and count paywalled chapter opens, ' +
  'which live tracking excludes.';
