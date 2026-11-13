// Filters shared by every ClickHouse query that reads request-level events.
//
// Declared once because a divergence here fails silently in the worst direction: a copy that misses an
// updated internal range starts counting our own infrastructure as user signal, so a vote-ring panel
// reports clusters made of Civitai traffic and nothing anywhere errors.
//
// 🔴 THE RANGE LIST NOW LIVES IN `@civitai/shared/clickhouse-ip-filters`, because the main Next app
// reads the same table and cannot import anything from `apps/moderator`. It is re-exported here so
// this app's existing importers are unchanged; adding a range in the shared module reaches both.
import { publicIpOnlySql } from '@civitai/shared/clickhouse-ip-filters';

export { INTERNAL_IP_RANGE } from '@civitai/shared/clickhouse-ip-filters';

/** Interpolated into ClickHouse queries, which do NO escaping — every IP must match this first. */
export const IP_PATTERN = /^[0-9a-fA-F.:]{3,45}$/;

// Why the range list and the `ip != ''` guard come first: see `@civitai/shared/clickhouse-ip-filters`.
export const PUBLIC_IP_ONLY = publicIpOnlySql();

const DELETE_TYPES = [
  'Image_Delete',
  'Comment_Delete',
  'CommentV2_Delete',
  'Review_Delete',
  'Question_Delete',
  'Answer_Delete',
  'BountyEntry_Delete',
  'Article_Delete',
  'Post_Delete',
] as const;

// A removal is not a reaction given: counting both double-counts react-then-unreact.
export const CREATES_ONLY = `type NOT IN (${DELETE_TYPES.map((t) => `'${t}'`).join(',')})`;

/**
 * `userActivities` rows the account made itself, so `ip` is the account's own address. Moderator
 * actions (`Banned`, `Muted`, `ExcludedFromLeaderboard`, ...) are written with the ACTING moderator's
 * address against the target: read as the target's, they link every account one moderator touched.
 */
export const OWN_ACTIVITY_ONLY = `type IN ('Registration', 'Login', 'Subscribe')`;

/** `column >= now() - N DAY`, with N truncated to a whole day count in `1..max`. */
export const daysWindow = (days: number, { max = Infinity, column = 'time' } = {}) =>
  `${column} >= now() - INTERVAL ${Math.min(max, Math.max(1, Math.trunc(days)))} DAY`;
