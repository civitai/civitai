import { useMemo } from 'react';
import { chunkIds } from '~/utils/array-helpers';
import { trpc } from '~/utils/trpc';

// The most ids `image.getSongPlays` takes in one read.
const MAX_PLAY_IDS = 100;
const PLAYS_STALE_MS = 5 * 60 * 1000;

/**
 * Play counts for a list of songs, by song id: one read per 100 songs, chunked in arrival order so
 * a page appended to the list leaves the earlier chunks' reads alone. A song the server could not
 * answer for is absent.
 */
export function useSongListPlays(songIds: number[]) {
  const chunks = useMemo(
    () => chunkIds(songIds, MAX_PLAY_IDS),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unstable array; its join is the key
    [songIds.join(',')]
  );
  const queries = trpc.useQueries((t) =>
    chunks.map((ids) =>
      t.image.getSongPlays(
        { ids },
        { staleTime: PLAYS_STALE_MS, placeholderData: (previous) => previous }
      )
    )
  );
  return useMemo(
    (): Record<number, number> => Object.assign({}, ...queries.map((query) => query.data ?? {})),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queries unstable; their data is the key
    queries.map((query) => query.data)
  );
}
