import type { BotAccountHeuristic } from '../scoring';
import { rampScore } from './ramp';

/**
 * HEURISTIC 1 — how fast the account posted, against how long it has existed.
 *
 * Adapted from `apps/moderator/src/lib/server/comment-spam.service.ts`, which finds a comment burst
 * by counting an account's comments inside one hour and then throwing away every burst from an
 * account older than a few days. Two things carry over and one deliberately does not:
 *
 *  - CARRIED OVER: the rate is measured AGAINST ACCOUNT AGE rather than in absolute terms. Forty
 *    uploads is unremarkable from a year-old creator and is the whole signal from an account that
 *    registered twenty minutes ago. That service expresses it as an age cut-off on a burst; here the
 *    cohort is already age-bounded to a day, so age becomes the DIVISOR instead of a filter, which
 *    is the same idea with more resolution — it separates the twenty-minute account from the
 *    twenty-three-hour one, where a cut-off would keep both.
 *  - CARRIED OVER: the floor at zero for a clock that ran backwards. That service floors
 *    `ageAtBurstHours` because a burst timestamped before its own signup is skew between two
 *    systems, not a negative age.
 *  - NOT CARRIED OVER: its ClickHouse read. Everything this heuristic needs — the counts and the
 *    registration time — already rode in on the cohort member, so this heuristic costs NO query at
 *    all. It is the cheapest of the three by a wide margin and the only one that cannot degrade.
 *
 * 🔴 IT COUNTS `posts.all`, NOT `posts.visible`, and that is the same decision membership turns on.
 * An account whose forty uploads were all blocked by the scanner posted forty things at some rate;
 * the scanner's verdict is evidence ABOUT the account, not a reason to score it as idle. Reading
 * `visible` here would zero the score of precisely the accounts this detector exists to find, and it
 * would do it silently.
 */

/** The id is a metric key and a board-facing sub-score name — an identifier, not a sentence. */
export const POSTING_VELOCITY_ID = 'posting-velocity';

/**
 * The youngest age the divisor will use, in hours.
 *
 * 🔴 WITHOUT IT THE RATE IS UNBOUNDED AND THE SCORE IS AN ARTEFACT OF SCHEDULING. An account created
 * ninety seconds before the run posts three items at 120/hour — a top score for something entirely
 * ordinary — and how extreme it looks depends on the gap between the signup and the cron tick, which
 * is nothing to do with the account. Fifteen minutes is long enough that the divisor stops being
 * dominated by that gap and short enough to still separate a twenty-minute wave from a six-hour one.
 *
 * This is a judgement, not a measurement, and it is the constant most likely to be wrong. It is also
 * why `MIN_ITEMS` below exists: the two guard the same corner from different sides.
 */
export const MIN_AGE_HOURS = 0.25;

/**
 * How many items an account must have posted before a rate is computed at all.
 *
 * 🔴 THE RATE ALONE IS NOT ENOUGH, because the divisor floor makes a tiny numerator look fast: two
 * items from a ten-minute-old account is 8/hour, which clears `ZERO_AT` on its own. Two items is not
 * a wave under any reading, and a detector that says it is will say it about a large share of every
 * day's genuine signups — the "fires on 90% of accounts" uselessness the scoring seam was built to
 * make visible. So volume and rate must BOTH be present.
 */
export const MIN_ITEMS = 5;

/** The fastest posting rate still worth nothing, in items per hour. */
export const ZERO_AT_PER_HOUR = 4;
/** The rate at which the heuristic is fully convinced, in items per hour. */
export const ONE_AT_PER_HOUR = 40;

/** Hours between registration and the scan instant, floored at the divisor's minimum.
 *
 *  Exported because the flooring is behaviour worth asserting on its own: a negative age is clock
 *  skew between the app and the database, and a rate computed from one is a negative rate. */
export function effectiveAgeHours(createdAt: Date, now: Date): number {
  const raw = (now.getTime() - createdAt.getTime()) / 3_600_000;
  return Math.max(MIN_AGE_HOURS, raw);
}

/** Items posted per hour of (floored) account age. */
export function itemsPerHour(total: number, createdAt: Date, now: Date): number {
  return total / effectiveAgeHours(createdAt, now);
}

export const postingVelocityHeuristic: BotAccountHeuristic = {
  id: POSTING_VELOCITY_ID,
  description:
    'Items posted per hour of account age, over everything the account posted rather than only ' +
    'what is still on the site. Costs no query — the cohort read already carries both numbers.',
  weight: 1,
  score: ({ member, now }) => {
    const total = member.posts.all.total;
    if (total < MIN_ITEMS) return 0;
    return rampScore(itemsPerHour(total, member.createdAt, now), ZERO_AT_PER_HOUR, ONE_AT_PER_HOUR);
  },
  explain: ({ member, now }, score) => {
    if (score <= 0) return null;
    const rate = itemsPerHour(member.posts.all.total, member.createdAt, now);
    const age = effectiveAgeHours(member.createdAt, now);
    return (
      `posted ${member.posts.all.total} item(s) in ${age.toFixed(1)}h — ` +
      `${rate.toFixed(1)}/hour (scores above ${ZERO_AT_PER_HOUR}/hour)`
    );
  },
};
