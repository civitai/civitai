import type { NextApiRequest } from 'next';
import { dbRead } from '~/server/db/client';
import { getFeatureFlagsAsync } from '~/server/services/feature-flags.service';
import { countGiftClaims } from '~/server/services/gift-claim-count';
import type { UsageLimitId } from '~/shared/constants/usage-limits';
import type { SessionUser } from '~/types/session';

/**
 * How many times the user used a limit in `[start, end)`. For a calendar-window product limit that
 * its own service enforces: `rateLimit()` buckets keep a rolling day, so they cannot count it.
 * `null` gives no row: the user cannot reach the feature.
 */
export type UsageLimitCounter = (args: {
  user: SessionUser;
  req: NextApiRequest;
  start: Date;
  end: Date;
}) => Promise<number | null>;

/**
 * The counters `/me/limits` uses for calendar-window product limits. A `utc-day` or `utc-month`
 * product entry gets a row only once its enforcing service registers its counter here.
 */
export const usageLimitCounters: Partial<Record<UsageLimitId, UsageLimitCounter>> = {
  'gifts.monthly': async ({ user, req, start, end }) =>
    (await getFeatureFlagsAsync({ user, req })).modelGiftLinks
      ? countGiftClaims(dbRead, user.id, start, end)
      : null,
};

/** The UTC day or month containing `now`. */
export function calendarWindow(type: 'utc-day' | 'utc-month', now: number) {
  const d = new Date(now);
  const start =
    type === 'utc-day'
      ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
      : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end =
    type === 'utc-day'
      ? new Date(start.getTime() + 24 * 60 * 60 * 1000)
      : new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return { start, end };
}
