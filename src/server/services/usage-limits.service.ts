import type { NextApiRequest } from 'next';
import { POST_CREATE_RATE_LIMIT_KEY, postRateLimits } from '~/server/schema/post.schema';
import { resolveUsageLimitRules } from '~/server/services/usage-limit-config.service';
import { peekRateLimit } from '~/server/utils/rate-limit-bucket';
import type { RateLimit } from '~/server/utils/rate-limit-window';
import { getUsageLimitDef, type UsageLimitRef } from '~/shared/constants/usage-limits';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { Flags } from '~/shared/utils/flags';
import type { SessionUser } from '~/types/session';

/** A scoped token reads its limits with either: an app that posts needs them without profile access. */
export const USAGE_LIMITS_SCOPES = [TokenScope.UserRead, TokenScope.MediaWrite] as const;

/**
 * The product limits a caller can read their standing against. `sharedKey` must be the one the
 * limited procedures pass to `rateLimit()`, so the read sees the bucket they write.
 */
const USAGE_LIMIT_AREAS: { area: string; sharedKey: string; limits: UsageLimitRef }[] = [
  { area: 'posts', sharedKey: POST_CREATE_RATE_LIMIT_KEY, limits: postRateLimits },
];

const labelOf = (id: string) => getUsageLimitDef(id).label;

export type UsageLimit = {
  id: string;
  area: string;
  label: string;
  /** `null` (with every count) for a caller the limit does not apply to: a moderator. */
  limit: number | null;
  used: number | null;
  remaining: number | null;
  windowSeconds: number | null;
  /** When the caller can next use it, at the limit; `null` while `remaining > 0`. */
  nextAt: string | null;
  /** When every attempt in the window has aged out. */
  resetAt: string | null;
};

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/**
 * The caller's standing against every product limit that applies to them now, read from the
 * caller's own buckets without recording anything. `ids` narrows the list; it can only remove
 * rows, never add a rule the caller is not under.
 */
export async function getUsageLimits({
  user,
  req,
  tokenScope,
  ids,
}: {
  user: SessionUser;
  req: NextApiRequest;
  /** The caller's credential scope; `TokenScope.Full` for a cookie session. */
  tokenScope: number;
  ids?: readonly string[];
}): Promise<{ limits: UsageLimit[] }> {
  // Null rows would tell a token that its user is a moderator, which `/api/v1/me` releases only
  // to a session or a UserRead token. Anyone else sees a moderator's rows as a regular user's.
  const showExemption =
    user.isModerator &&
    (tokenScope === TokenScope.Full || Flags.hasFlag(tokenScope, TokenScope.UserRead));
  const wanted = ids && ids.length > 0 ? new Set(ids) : undefined;
  const limits: UsageLimit[] = [];
  for (const { area, sharedKey, limits: ref } of USAGE_LIMIT_AREAS) {
    // Resolve first, as `rateLimit()` does, so `ids` can only drop rows, never change a number.
    const rules: RateLimit[] = await resolveUsageLimitRules(ref.usageLimitIds, user);
    const productRules = rules.filter(
      (rule) => rule.kind === 'product' && rule.id && (!wanted || wanted.has(rule.id))
    );
    if (productRules.length === 0) continue;
    // `rateLimit()` skips moderators, so nothing they do is recorded: report no limit.
    if (showExemption) {
      for (const rule of productRules) limits.push(unlimited(rule.id as string, area));
      continue;
    }
    const usages = await peekRateLimit({ rules: productRules, sharedKey, user, req });
    for (const { rule, used, remaining, nextAt, resetAt } of usages) {
      const id = rule.id as string;
      limits.push({
        id,
        area,
        label: labelOf(id),
        limit: rule.limit,
        used,
        remaining,
        windowSeconds: rule.period,
        nextAt: remaining > 0 ? null : iso(nextAt),
        resetAt: iso(resetAt),
      });
    }
  }
  return { limits };
}

function unlimited(id: string, area: string): UsageLimit {
  return {
    id,
    area,
    label: labelOf(id),
    limit: null,
    used: null,
    remaining: null,
    windowSeconds: null,
    nextAt: null,
    resetAt: null,
  };
}
