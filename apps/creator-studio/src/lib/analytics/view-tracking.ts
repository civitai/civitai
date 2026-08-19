// The liveness probe behind every `tracking` flag on the analytics surfaces, kept here rather than inline in
// `$lib/server/analytics` so it can be tested without the server module's database and Redis imports.

// Was ANY row of this entity type written platform-wide **within this range**? `LIMIT 1` short-circuits, and
// `entityType` leads the primary key on `daily_views`, so this is a prefix seek rather than a scan.
//
// 🔴 The range is the whole point. The numbers this guards are scoped to the selected period, so an all-time
// answer claims "tracking is live" for a month that predates the emitter, and the surface then renders a
// confident row of zeros instead of its fallback. Comics and 3D shipped that way: `daily_views` held rows for
// today only while the default period is the last completed month, so every creator's default Comics and 3D
// tabs read zero. The symptom clears itself once a month of data exists, which is exactly why the guard has to
// be range-scoped rather than waited out — the next entity type to get view tracking hits it again on the day
// it is switched on.
export function viewTrackingSql(entityType: string, from: string, to: string): string {
  return `SELECT 1 AS one FROM daily_views WHERE entityType = '${entityType}' AND createdDate >= toDate('${from}') AND createdDate <= toDate('${to}') LIMIT 1`;
}
