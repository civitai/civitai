import type { NextApiRequest } from 'next';
import { COMMENT_V3_RATE_LIMIT_KEY } from '~/server/schema/comment.schema';
import { POST_CREATE_RATE_LIMIT_KEY } from '~/server/schema/post.schema';
import { resolveUsageLimitRules } from '~/server/services/usage-limit-config.service';
import { peekRateLimit } from '~/server/utils/rate-limit-bucket';
import type { RateLimit } from '~/server/utils/rate-limit-window';
import {
  getUsageLimitDef,
  isBucketCountable,
  usageLimitDefs,
  type UsageLimitDef,
} from '~/shared/constants/usage-limits';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { Flags } from '~/shared/utils/flags';
import type { SessionUser } from '~/types/session';

/** A scoped token reads its limits with either: an app that posts needs them without profile access. */
export const USAGE_LIMITS_SCOPES = [TokenScope.UserRead, TokenScope.MediaWrite] as const;

/**
 * The bucket each product area's procedures share: it must be the `sharedKey` they pass to
 * `rateLimit()`, so the read sees the bucket they write. A product area missing here has no rows.
 */
const SHARED_KEY_BY_AREA: Record<string, string> = {
  posts: POST_CREATE_RATE_LIMIT_KEY,
  comments: COMMENT_V3_RATE_LIMIT_KEY,
};

/** Every bucket-counted product limit, grouped by area in registry display order. */
const USAGE_LIMIT_AREAS = Object.entries(SHARED_KEY_BY_AREA).map(([area, sharedKey]) => ({
  area,
  sharedKey,
  ids: usageLimitDefs
    .filter((def) => def.area === area && def.kind === 'product' && isBucketCountable(def.window))
    .map((def) => def.id),
}));

const labelOf = (id: string) => getUsageLimitDef(id).label;

export type UsageLimitWindow = UsageLimitDef['window']['type'];

export type UsageLimit = {
  id: string;
  area: string;
  label: string;
  /** `null` (with every count) for a caller the limit does not apply to: a moderator. */
  limit: number | null;
  used: number | null;
  remaining: number | null;
  windowSeconds: number | null;
  /** `rateLimit()` windows are rolling; calendar windows (UTC day/month) reset at a boundary. */
  window: UsageLimitWindow | null;
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
  // One bucket read per area, in parallel; rows keep registry order.
  const byArea = await Promise.all(
    USAGE_LIMIT_AREAS.map(async ({ area, sharedKey, ids: areaIds }): Promise<UsageLimit[]> => {
      // Resolve first, as `rateLimit()` does, so `ids` can only drop rows, never change a number.
      const rules: RateLimit[] = await resolveUsageLimitRules(areaIds, user);
      const productRules = rules.filter(
        (rule) => rule.kind === 'product' && rule.id && (!wanted || wanted.has(rule.id))
      );
      if (productRules.length === 0) return [];
      // `rateLimit()` skips moderators, so nothing they do is recorded: report no limit.
      if (showExemption) return productRules.map((rule) => unlimited(rule.id as string, area));
      const usages = await peekRateLimit({ rules: productRules, sharedKey, user, req });
      return usages.map(({ rule, used, remaining, nextAt, resetAt }) => {
        const id = rule.id as string;
        return {
          id,
          area,
          label: labelOf(id),
          limit: rule.limit,
          used,
          remaining,
          windowSeconds: rule.period,
          window: getUsageLimitDef(id).window.type,
          nextAt: remaining > 0 ? null : iso(nextAt),
          resetAt: iso(resetAt),
        };
      });
    })
  );
  const limits = byArea.flat();
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
    window: null,
    nextAt: null,
    resetAt: null,
  };
}
