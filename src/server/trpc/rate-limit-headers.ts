import type { RuleUsage } from '~/server/utils/rate-limit-window';

/**
 * `X-RateLimit-Limit/Remaining/Reset` for product limits, GitHub/OpenAI-style. `rateLimit()` notes
 * the binding product usage per request; `responseMeta` turns it into headers. A batch shares one
 * set of headers across calls, so only a response carrying exactly one call, with exactly one
 * product usage noted, gets them. Abuse limits never do: they publish no counts.
 */
export type RateLimitHeaderUsage = { limit: number; remaining: number; resetAt: number };

const noted = new WeakMap<object, RateLimitHeaderUsage[]>();

/** The product usage a client should see: least remaining, then the longest wait. */
export function headerUsageOf(usages: RuleUsage[]): RateLimitHeaderUsage | undefined {
  let binding: RuleUsage | undefined;
  for (const usage of usages) {
    if (usage.rule.kind !== 'product' || usage.nextAt === null) continue;
    if (
      !binding ||
      usage.remaining < binding.remaining ||
      (usage.remaining === binding.remaining && usage.nextAt > (binding.nextAt ?? 0))
    )
      binding = usage;
  }
  if (!binding || binding.nextAt === null) return undefined;
  return { limit: binding.rule.limit, remaining: binding.remaining, resetAt: binding.nextAt };
}

export function noteRateLimitUsage(req: object, usages: RuleUsage[]) {
  const usage = headerUsageOf(usages);
  if (!usage) return;
  const list = noted.get(req) ?? [];
  list.push(usage);
  noted.set(req, list);
}

/** Headers for a single-call response, or none. `Reset` is seconds until a slot frees. */
export function rateLimitHeaders({
  req,
  callCount,
  now = Date.now(),
}: {
  req: object | undefined;
  callCount: number;
  now?: number;
}): Record<string, string> | undefined {
  if (!req || callCount !== 1) return undefined;
  const list = noted.get(req);
  if (!list || list.length !== 1) return undefined;
  return headerValues(list[0], now);
}

function headerValues({ limit, remaining, resetAt }: RateLimitHeaderUsage, now: number) {
  return {
    'X-RateLimit-Limit': String(limit),
    'X-RateLimit-Remaining': String(remaining),
    'X-RateLimit-Reset': String(Math.max(0, Math.ceil((resetAt - now) / 1000))),
  };
}

/** For REST routes that enforce a product limit outside `rateLimit()`. */
export function setRateLimitHeaders(
  res: { setHeader(name: string, value: string): unknown },
  usage: RateLimitHeaderUsage,
  now = Date.now()
) {
  for (const [name, value] of Object.entries(headerValues(usage, now))) res.setHeader(name, value);
}
