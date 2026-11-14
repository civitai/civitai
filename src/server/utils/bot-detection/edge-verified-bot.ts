import { env } from '~/env/server';
import { timingSafeEqualStrings } from '~/server/utils/timing-safe-equal';

/** Set by the edge on a verified crawler's request, to `CF_VERIFIED_BOT_HEADER_SECRET`. */
export const CF_VERIFIED_BOT_HEADER = 'x-civ-cf-verified-bot';

/** Why a request does not carry the edge's verified-crawler header. */
export type EdgeVerifiedBotRefusal = 'no-bot-header' | 'no-secret' | 'bot-header-mismatch';

/**
 * Whether the edge marked this request as a verified crawler: `null` when the header holds the
 * secret, else why not. An unset secret refuses every request.
 */
export function edgeVerifiedBotRefusal(
  raw: string | string[] | null | undefined
): EdgeVerifiedBotRefusal | null {
  const presented = Array.isArray(raw) ? raw[0] : raw;
  if (!presented) return 'no-bot-header';
  const secret = env.CF_VERIFIED_BOT_HEADER_SECRET;
  if (!secret) return 'no-secret';
  if (!timingSafeEqualStrings(secret, presented)) return 'bot-header-mismatch';
  return null;
}
