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
  return readSongCovers(input, options);
}

// Hook-free, so the `useQueries` stub can call it once per read.
function readSongCovers(input: unknown, options?: { enabled?: boolean }) {
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

/**
 * The `image.getSongPlays` read: `served` maps a song id to its play count; `requests` records the
 * ids of every read.
 */
export const songPlays = {
  served: {} as Record<number, number>,
  requests: [] as number[][],
  reset() {
    songPlays.served = {};
    songPlays.requests = [];
  },
};

function readSongPlays(input: unknown, options?: { enabled?: boolean }) {
  if (options?.enabled === false) return { data: undefined };
  const { ids } = getSongCoversSchema.parse(input);
  songPlays.requests.push(ids);
  return {
    data: Object.fromEntries(
      ids.flatMap((id) => (id in songPlays.served ? [[id, songPlays.served[id]]] : []))
    ),
  };
}

/**
 * The `commentv3.getTimed` read the bar makes for the current song: `served` maps a song id to its
 * timed comments; `requests` records each enabled read's song id.
 */
export const timedComments = {
  served: {} as Record<number, unknown[]>,
  requests: [] as number[],
  reset() {
    timedComments.served = {};
    timedComments.requests = [];
  },
};

function useTimedCommentsQuery(input: { imageId: number }, options?: { enabled?: boolean }) {
  if (options?.enabled === false) return { data: undefined };
  timedComments.requests.push(input.imageId);
  return { data: timedComments.served[input.imageId] ?? [] };
}

/**
 * The song reads the phone's now-playing sheet makes: `image.get` (its comment count, reactions and
 * remix source) answered from `images`, `image.getSongLyrics` from `lyrics`, by song id.
 */
export const songDetails = {
  images: {} as Record<number, unknown>,
  lyrics: {} as Record<number, { t: number | null; text: string }[]>,
  reset() {
    songDetails.images = {};
    songDetails.lyrics = {};
  },
};

function useSongImageQuery(input: { id: number }, options?: { enabled?: boolean }) {
  if (options?.enabled === false) return { data: undefined };
  return { data: songDetails.images[input.id] };
}

function useSongLyricsQuery(input: { id: number }, options?: { enabled?: boolean }) {
  if (options?.enabled === false) return { data: undefined, isLoading: false };
  return { data: songDetails.lyrics[input.id] ?? [], isLoading: false, isError: false };
}

/**
 * `trpc` with `image.getSongCovers` and `image.getSongPlays` (single and through `useQueries`)
 * answered by `songCovers` and `songPlays`, `image.get` and `image.getSongLyrics` by `songDetails`,
 * `image.getSongGenreTags` with no genre tags, and `commentv3.getTimed` by `timedComments`; for a
 * `vi.mock('~/utils/trpc')` factory.
 */
export function withSongCoversStub<T extends object>(trpc: T): T {
  answers = new WeakMap();
  const image = {
    getSongCovers: { useQuery: useSongCoversQuery },
    getSongPlays: { useQuery: readSongPlays },
    get: { useQuery: useSongImageQuery },
    getSongLyrics: { useQuery: useSongLyricsQuery },
    // The feed's genre map (`FeedSongsProvider`); no song here carries a genre tag.
    getSongGenreTags: { useQuery: () => ({ data: {} }) },
  };
  const commentv3 = { getTimed: { useQuery: useTimedCommentsQuery } };
  // The sheet's like: inert, as no test here presses it.
  const reaction = {
    toggleWithPoints: { useMutation: () => ({ mutate: () => undefined, isPending: false }) },
  };
  // `trpc.useQueries` for chunked reads: each `t.image.getSongCovers(input)` is one read.
  const useQueries = (build: (t: unknown) => unknown[]) =>
    (
      build({
        image: {
          getSongCovers: (input: unknown) => () => readSongCovers(input),
          getSongPlays: (input: unknown) => () => readSongPlays(input),
        },
      }) as (() => { data: unknown })[]
    ).map((read) => read());
  return new Proxy(trpc, {
    get: (target, key) =>
      key === 'image'
        ? image
        : key === 'commentv3'
        ? commentv3
        : key === 'reaction'
        ? reaction
        : key === 'useQueries'
        ? useQueries
        : Reflect.get(target, key),
  });
}
