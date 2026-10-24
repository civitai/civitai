// Entity-type values for the ClickHouse view/impression tables, in one place.
//
// These are string literals inside SQL, and a typo does NOT error — it returns zero rows. Verified against
// prod: `entityType = 'Model3Ds'` on `daily_views` (an Enum8 column) returns count 0 exactly like a valid
// value with no data would, and the LowCardinality(String) column on the impression tables behaves the same.
// So a mistyped literal ships as a permanently empty chart, indistinguishable from tracking that hasn't
// started yet — which is a state these surfaces legitimately have. Two silent failures with one symptom is
// how something stays broken for a month, hence the constants.
export const VIEW_ENTITY = {
  image: 'Image',
  article: 'Article',
  model: 'Model',
  comicProject: 'ComicProject',
  comicChapter: 'ComicChapter',
  model3d: 'Model3D',
} as const;

export const IMPRESSION_ENTITY = {
  image: 'Image',
  model: 'Model',
  announcement: 'Announcement',
} as const;

// The arms of `impressions_daily_by_owner`. NOT every impression entity: that table is populated by an MV
// with one arm per ownership source in ClickHouse, and only Image and Model have one. Announcement
// impressions exist per-entity in `daily_impressions` and are read by id from the announcements page —
// summing them here would add a column the MV never writes, so a creator-wide total would silently
// under-report by however much it claimed to include.
export const OWNER_IMPRESSION_ARMS = [IMPRESSION_ENTITY.image, IMPRESSION_ENTITY.model] as const;

export type ViewEntity = (typeof VIEW_ENTITY)[keyof typeof VIEW_ENTITY];
export type ImpressionEntity = (typeof IMPRESSION_ENTITY)[keyof typeof IMPRESSION_ENTITY];
