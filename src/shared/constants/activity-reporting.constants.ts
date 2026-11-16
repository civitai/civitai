/**
 * Limits for the click-activity beacon: `ActivityReportingProvider` (client) posts batches of
 * `data-activity` names to `/api/internal/activity` (server), which writes one ClickHouse row per
 * entry. Shared so the client's chunk size and the server's cap cannot drift apart unseen.
 *
 * The provider buffers one entry per click on a `data-activity` element and flushes every 10 s, so
 * a batch has no inherent bound. A human clicking flat out manages roughly 10-15 clicks a second,
 * about 150 entries per 10 s window, and that is the largest batch a bundle from before chunking
 * can realistically send.
 *
 * - `ACTIVITY_CLIENT_BATCH_SIZE` (50): the most the current provider puts in one request; a bigger
 *   buffer goes out as several requests.
 * - `ACTIVITY_BATCH_MAX` (200): the server's cap. Above the ~150 a pre-chunking bundle can send, so
 *   tabs still running an old bundle through a deploy are not refused, and 4x the client's chunk.
 *   A bigger batch is refused whole (400), never truncated.
 */
export const ACTIVITY_CLIENT_BATCH_SIZE = 50;
export const ACTIVITY_BATCH_MAX = 200;

/**
 * Longest accepted activity name. The names are developer-written `data-activity` slugs
 * (`remix:image-card-home`, `follow-recommendation:details`, `tool-click:<id>`).
 */
export const ACTIVITY_NAME_MAX_LENGTH = 100;
