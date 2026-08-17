// Exclusive: the first day `Model3DView` events were written live. Everything
// strictly before it in `daily_views` came from the `pageViews` backfill
// (scripts/oneoffs/backfill-model3d-views.ts), which refuses to run unless its
// `--until` equals this value.
export const MODEL3D_VIEW_TRACKING_CUTOVER = '2026-08-18';

// The two spans are not the same measurement, so a consumer that plots across
// the boundary has to say so: before it, one row per page load; after it, one
// beacon per detail-page mount debounced 1s. Detail page only — `/edit` and
// `/reviews` are excluded on both sides.
export const MODEL3D_VIEW_TRACKING_NOTE =
  'Views before ' +
  MODEL3D_VIEW_TRACKING_CUTOVER +
  ' are backfilled from page-load history and are not directly comparable to tracked views after it.';
