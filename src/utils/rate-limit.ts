import { parseRateLimitMeta, type RateLimitMeta } from '~/shared/utils/rate-limit-meta';

/** The rate-limit meta of a refusal (a `TRPCClientError` or anything with `data.rateLimit`). */
export function getRateLimit(error: unknown): RateLimitMeta | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return undefined;
  return parseRateLimitMeta((data as { rateLimit?: unknown }).rateLimit);
}

/** "Try again at 4:12 PM." in the viewer's locale and zone, with the weekday when not today. */
export function retryAtText(rateLimit: RateLimitMeta, now = new Date(), locale?: string) {
  const retryAt = new Date(rateLimit.retryAt);
  const sameDay = retryAt.toDateString() === now.toDateString();
  const time = retryAt.toLocaleString(locale, {
    ...(sameDay ? {} : { weekday: 'short' }),
    hour: 'numeric',
    minute: '2-digit',
  });
  return `Try again at ${time}.`;
}

const PROMISES_A_TIME = /\b(try again|retry)\b/i;

/** `message` with the retry time added, unless it already tells the viewer when to retry. */
export function withRetryText(message: string, rateLimit: RateLimitMeta | undefined) {
  if (!rateLimit || PROMISES_A_TIME.test(message)) return message;
  return `${message} ${retryAtText(rateLimit)}`;
}
