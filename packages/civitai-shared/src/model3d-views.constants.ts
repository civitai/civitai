// Tracking began 2026-08-17 17:21:31 UTC; everything before that is backfilled
// from page-load history. The two are not the same measurement — page loads ran
// ~1.5x the debounced beacons that replaced them — so a chart crossing this day
// steps down for reasons that have nothing to do with the creator.
export const MODEL3D_VIEW_TRACKING_CUTOVER = '2026-08-17';

export const MODEL3D_VIEW_TRACKING_NOTE =
  'Views up to and including ' +
  MODEL3D_VIEW_TRACKING_CUTOVER +
  ' are partly backfilled from page-load history and read higher than tracked views after it.';
