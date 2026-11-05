/**
 * Set on the page request by `_app.getInitialProps` to the bot-cache route name when the request
 * may be answered with an edge-cacheable render (`~/server/bot-cache/bot-cache`), and cleared on
 * every other run. Here rather than in `~/server/bot-cache` so `_app` needs no server import.
 */
export const BOT_CACHE_REQ_KEY = 'civBotCacheRoute';

/** Set by `createServerSideProps` when a prefetch of a bot-cache candidate failed. */
export const BOT_CACHE_PREFETCH_FAILED_REQ_KEY = 'civBotCachePrefetchFailed';

/**
 * `verifiedBot` in an edge-cacheable render: the same value for every crawler, so the cached
 * object does not depend on which one asked.
 */
export const BOT_CACHE_VERIFIED_BOT = 'edge-crawler';
