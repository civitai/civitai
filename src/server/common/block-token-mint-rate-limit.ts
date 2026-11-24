/**
 * The block-token mint's per-(subject, instance) fixed window (`BlockTokenService.checkRateLimit`).
 * The mint route reads the window from here for its refusal's `Retry-After`, since the limiter
 * returns no TTL: a refused mint is admitted again within one window.
 */
export const BLOCK_TOKEN_MINT_RATE_LIMIT = { max: 60, windowSeconds: 60 } as const;
