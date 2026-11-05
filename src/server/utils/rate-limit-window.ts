import type { SessionUser } from '~/types/session';
import type { RateLimitKind, RateLimitMeta } from '~/shared/utils/rate-limit-meta';

export type RateLimit = {
  /** Stable, unique per rule; sent on refusals and keyed on by clients. */
  id?: string;
  /** Unset means abuse: a refusal then carries no counts. */
  kind?: RateLimitKind;
  limit: number;
  period: number; // seconds
  userReq?: (user: SessionUser) => boolean;
  errorMessage?: string;
};

export type RuleUsage = {
  rule: RateLimit;
  used: number;
  remaining: number;
  refused: boolean;
  /** When this rule next admits more: the retry time when refused. `null` with no attempts or a limit of 0. */
  nextAt: number | null;
  /** When every attempt in the window has aged out. */
  resetAt: number | null;
};

/** The rules that apply to `user`: per period, the highest limit among rules whose `userReq` passes. */
export function selectRateLimitRules(rules: RateLimit[], user: SessionUser | undefined) {
  const validLimits: RateLimit[] = [];
  for (const rateLimit of rules) {
    const matchedPeriod = validLimits.find((x) => x.period === rateLimit.period);
    if (matchedPeriod?.limit && matchedPeriod.limit > rateLimit.limit) continue;
    if (!rateLimit.userReq || (user && rateLimit.userReq(user))) {
      if (matchedPeriod) {
        validLimits.splice(validLimits.indexOf(matchedPeriod), 1, rateLimit);
      } else {
        validLimits.push(rateLimit);
      }
    }
  }
  return validLimits;
}

/**
 * Counts `attempts` (epoch ms, refused attempts never recorded) against each rule's sliding
 * window. A rule refuses once the window holds `limit`, so a cap of N admits exactly N.
 */
export function evaluateRateLimitWindow(
  rules: RateLimit[],
  attempts: number[],
  now: number
): RuleUsage[] {
  return rules.map((rule) => {
    const windowMs = rule.period * 1000;
    const inWindow = attempts.filter((x) => x > now - windowMs).sort((a, b) => a - b);
    const used = inWindow.length;
    const remaining = Math.max(0, rule.limit - used);
    // No window frees a slot: such a rule is a gate (an entitlement, a first-day block), not a wait.
    if (rule.limit === 0)
      return { rule, used, remaining, refused: true, nextAt: null, resetAt: null };
    if (used === 0) return { rule, used, remaining, refused: false, nextAt: null, resetAt: null };
    // Admitted again once enough of the oldest age out that `used < limit`. Usually
    // used = limit (index 0), but concurrent calls can all pass the check before any records.
    const nextAt = inWindow[Math.max(0, used - rule.limit)] + windowMs;
    return {
      rule,
      used,
      remaining,
      refused: used >= rule.limit,
      nextAt,
      resetAt: inWindow[used - 1] + windowMs,
    };
  });
}

/**
 * The refusing rule that decides the response, or `undefined` when none refused: a limit-0 rule
 * if any, else the one whose wait is longest (the first of equals), so the message, counts and
 * retry time all describe the same limit and retrying then cannot hit a second refusal.
 */
export function bindingRefusal(usages: RuleUsage[]): RuleUsage | undefined {
  const refused = usages.filter((usage) => usage.refused);
  const gate = refused.find((usage) => usage.nextAt === null);
  if (gate) return gate;
  return refused.reduce<RuleUsage | undefined>(
    (longest, usage) => (!longest || (usage.nextAt ?? 0) > (longest.nextAt ?? 0) ? usage : longest),
    undefined
  );
}

/**
 * The meta for the binding refusal, or `undefined` when no rule refused or the binding rule has
 * no retry time (limit 0). Abuse rules (no `kind: 'product'`) carry no counts.
 */
export function rateLimitMetaForRefusal(
  usages: RuleUsage[],
  now: number
): RateLimitMeta | undefined {
  const refusal = bindingRefusal(usages);
  if (!refusal || refusal.nextAt === null) return undefined;
  const meta: RateLimitMeta = {
    retryAfterSeconds: Math.max(1, Math.ceil((refusal.nextAt - now) / 1000)),
    retryAt: new Date(refusal.nextAt).toISOString(),
  };
  const { rule } = refusal;
  if (rule.id) meta.id = rule.id;
  if (rule.kind !== 'product') return meta;
  return {
    ...meta,
    kind: 'product',
    limit: rule.limit,
    used: refusal.used,
    remaining: refusal.remaining,
    windowSeconds: rule.period,
    resetAt: new Date(refusal.resetAt ?? refusal.nextAt).toISOString(),
  };
}
