import { getSongCoversSchema } from '~/server/schema/image.schema';
import type { PlayerSongCover } from '~/server/services/post.service';

/**
 * The `image.getSongCovers` read for the player's browser tests: `served` is what the server holds;
 * `requests` records the ids of every read, or `'invalid'` when the procedure's real input schema
 * refuses them (the server would answer with an error, so no cover shows).
 */
export const songCovers = {
  served: [] as PlayerSongCover[],
  requests: [] as (number[] | 'invalid')[],
  reset() {
    songCovers.served = [];
    songCovers.requests = [];
  },
};

// One answer per (served, ids), so a re-render gets the same array back as React Query would.
let answers = new WeakMap<PlayerSongCover[], Map<string, PlayerSongCover[]>>();

function useSongCoversQuery(input: unknown, options?: { enabled?: boolean }) {
  if (options?.enabled === false) return { data: undefined };
  const parsed = getSongCoversSchema.safeParse(input);
  if (!parsed.success) {
    songCovers.requests.push('invalid');
    return { data: undefined };
  }
  const { ids } = parsed.data;
  songCovers.requests.push(ids);
  const byIds = answers.get(songCovers.served) ?? new Map<string, PlayerSongCover[]>();
  answers.set(songCovers.served, byIds);
  const key = ids.join(',');
  if (!byIds.has(key))
    byIds.set(
      key,
      songCovers.served.filter((cover) => ids.includes(cover.songId))
    );
  return { data: byIds.get(key) };
}

/** `trpc` with `image.getSongCovers` answered by `songCovers`; for a `vi.mock('~/utils/trpc')` factory. */
export function withSongCoversStub<T extends object>(trpc: T): T {
  answers = new WeakMap();
  const image = { getSongCovers: { useQuery: useSongCoversQuery } };
  return new Proxy(trpc, {
    get: (target, key) => (key === 'image' ? image : Reflect.get(target, key)),
  });
}
