// The first day `Model3DView` events were written live, and the day the two data
// sources meet. Read off production after the deploy rather than chosen: tracking
// began 2026-08-17 17:21:31 UTC.
//
// This day is MIXED. Views before 17:21:31 were backfilled from `pageViews`;
// views after it are live beacons. `daily_views` sums them into the correct
// total, but a consumer plotting the boundary should mark this day, not the one
// after it.
export const MODEL3D_VIEW_TRACKING_CUTOVER = '2026-08-17';

// The two spans are not the same measurement, so a consumer that plots across the
// boundary has to say so: before it, one row per page load; after it, one beacon
// per detail-page mount debounced 1s. Detail page only — `/edit` and `/reviews`
// are excluded on both sides.
export const MODEL3D_VIEW_TRACKING_NOTE =
  'Views up to and including ' +
  MODEL3D_VIEW_TRACKING_CUTOVER +
  ' are partly backfilled from page-load history and are not directly comparable to tracked views after it.';
