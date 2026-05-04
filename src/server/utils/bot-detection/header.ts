// Shared parsing for the verified-bot request header set by
// botDetectionMiddleware. Lives in its own file (rather than alongside
// verify-bot.ts) so client-side code paths can import the parser without
// pulling in the CIDR JSON snapshots verify-bot.ts loads at module init.

import type { VerifiedBot } from './verify-bot';

export const VERIFIED_BOT_HEADER = 'x-civitai-verified-bot';

/**
 * Narrows the raw value of the `x-civitai-verified-bot` request header
 * to a typed `VerifiedBot` identifier. Accepts both `string` and
 * `string[]` forms because Node's `IncomingHttpHeaders` can be either
 * depending on origin; returns `null` for any other shape.
 */
export function parseVerifiedBotHeader(
  raw: string | string[] | null | undefined
): VerifiedBot | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === 'googlebot' || value === 'bingbot' ? value : null;
}
