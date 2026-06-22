import type { RouterOutput } from '~/types/router';

// The tRPC output shape of `buzz.getUserMultipliers` — what the SSR seed and the
// query's `data`/`initialData` are typed as.
export type MultipliersSeed = RouterOutput['buzz']['getUserMultipliers'];

const toDateOrNull = (v: unknown): Date | null =>
  v == null ? null : v instanceof Date ? v : new Date(v as string | number);

/**
 * Revive the Date fields of an SSR-injected `buzz.getUserMultipliers` seed.
 *
 * The seed travels to the client via Next pageProps (plain JSON), which
 * stringifies the nested `rewardsBonusEvent.startsAt`/`.endsAt` (`DateTime?`) to
 * ISO strings — but a live superjson tRPC fetch revives them to real `Date`
 * objects. We revive the seed so the React Query cache holds the SAME shape
 * whether it was SSR-seeded or later refetched, avoiding a silent
 * seed-vs-refetch divergence.
 *
 * Everything else in the payload is numbers/booleans/null (`purchasesMultiplier`,
 * `rewardsMultiplier`, `baseRewardsMultiplier`, `globalRewardsBonus`,
 * `rewardsIneligible`, `userId`, and the event's `id`/`name`/`description`/
 * `articleId`/`bannerLabel`/`multiplier`) — those serialize identically under
 * JSON and superjson, so they need no revival. `rewardsBonusEvent` itself is
 * `null` in the common case (no active bonus event); only the active-event path
 * carries the Dates. `startsAt`/`endsAt` are themselves nullable (`DateTime?`),
 * so a present-but-null value must stay `null` (not become `undefined`).
 *
 * Pure + dependency-light so it can be unit-tested without pulling the
 * provider's React/trpc graph (mirrors `reviveAnnouncementsSeed`).
 */
export function reviveMultipliersSeed(
  multipliers?: MultipliersSeed
): MultipliersSeed | undefined {
  if (!multipliers) return undefined;
  const event = multipliers.rewardsBonusEvent;
  if (!event) return multipliers;
  return {
    ...multipliers,
    rewardsBonusEvent: {
      ...event,
      startsAt: toDateOrNull(event.startsAt),
      endsAt: toDateOrNull(event.endsAt),
    },
  };
}
