// Filtered out of the default view, not dropped — one toggle brings them back.
//
// 🔴 Filter in SQL, never over a fetched page: `getModActivity` limits four queries and merges them,
// so filtering the result narrows a window that was already truncated by the rows being filtered out.
// An account carrying 100 crowd votes since its last removal then reads as never enforced against, on
// the screen where the next strike is decided.
//
// `setNsfwLevel` is deliberately NOT here: `updateImageNsfwLevel` records it, and that is how the
// ingestion-error, ratings and downleveled queues BLOCK an image. It reads as a rating and is
// sometimes an enforcement action.
export const RATING_ACTIVITIES = [
  // Knights of New Order crowd votes — not a moderator's decision at all, and a busy image carries several.
  'setNsfwLevelKono',
  'ratingReview',
  'moderateTag',
  'disableTag',
  'addTag',
  'deleteTag',
];

/** Camel-cased enum values read as identifiers in a list a moderator scans. */
export const activityLabel = (activity: string) =>
  activity.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
