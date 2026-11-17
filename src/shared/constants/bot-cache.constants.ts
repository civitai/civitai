/**
 * Set on the page request by `_app.getInitialProps` to the bot-cache route name when the request
 * may be answered with a cacheable render (`~/server/bot-cache/bot-cache`), and cleared on
 * every other run. Here rather than in `~/server/bot-cache` so `_app` needs no server import.
 */
export const BOT_CACHE_REQ_KEY = 'civBotCacheRoute';

/** Set by `createServerSideProps` when a prefetch of a bot-cache candidate failed. */
export const BOT_CACHE_PREFETCH_FAILED_REQ_KEY = 'civBotCachePrefetchFailed';

/**
 * `hit` on a response the origin cache served, `miss` on an allowed request it rendered, and
 * `BOT_CACHE_LOOKUP_FAILED` on one it rendered because the lookup failed or timed out. Next copies
 * a proxy response header onto the page request as well, so the render reads it there too.
 */
export const BOT_CACHE_STATUS_HEADER = 'x-civ-bot-cache';
export const BOT_CACHE_LOOKUP_FAILED = 'error';
