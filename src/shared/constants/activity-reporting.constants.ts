/**
 * Limits for the click-activity beacon: `ActivityReportingProvider` (client) posts batches of
 * `data-activity` names to `/api/internal/activity` (server), which writes one ClickHouse row per
 * entry. Shared so the client's chunk size and the server's cap cannot drift apart unseen.
 *
 * A pre-chunking bundle sends its whole buffer in one request (about 150 entries in a 10 s window
 * when clicking flat out), so `ACTIVITY_BATCH_MAX` stays above that while old tabs survive a deploy.
 *
 * - `ACTIVITY_CLIENT_BATCH_SIZE` (50): the most the current provider puts in one request; a bigger
 *   buffer goes out as several requests.
 * - `ACTIVITY_BATCH_MAX` (200): the server's cap. A bigger batch is refused whole (400), never
 *   truncated.
 */
export const ACTIVITY_CLIENT_BATCH_SIZE = 50;
export const ACTIVITY_BATCH_MAX = 200;

/**
 * Longest accepted activity name. The names are developer-written `data-activity` slugs
 * (`remix:image-card-home`, `follow-recommendation:details`, `tool-click:<id>`).
 */
export const ACTIVITY_NAME_MAX_LENGTH = 100;
