import { useMemo } from 'react';
import { chunkIds } from '~/utils/array-helpers';
import type { RouterOutput } from '~/types/router';
import { trpc } from '~/utils/trpc';

// The most ids `image.getSongCovers` and `image.getSongPlays` take in one read.
export const MAX_SONG_IDS_PER_READ = 100;
export const SONG_LIST_STALE_MS = 5 * 60 * 1000;

type SongListProcedure = 'getSongCovers' | 'getSongPlays';
type SongListData<P extends SongListProcedure> = RouterOutput['image'][P] | undefined;

/**
 * One `image[procedure]` read per 100 of `songIds`, chunked in arrival order so a page appended to
 * the list leaves the earlier chunks' reads alone; the growing last chunk keeps its data on screen
 * while its longer read loads. Each chunk's data, the array stable while none of it changes.
 */
export function useSongListReads<P extends SongListProcedure>(
  procedure: P,
  songIds: number[]
): SongListData<P>[] {
  const chunks = useMemo(
    () => chunkIds(songIds, MAX_SONG_IDS_PER_READ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unstable array; its join is the key
    [songIds.join(',')]
  );
  const queries = trpc.useQueries((t) =>
    chunks.map((ids) =>
      // Both procedures take `{ ids }`; the union call is the same read for either.
      (t.image[procedure] as (typeof t.image)['getSongPlays'])(
        { ids },
        { staleTime: SONG_LIST_STALE_MS, placeholderData: (previous) => previous }
      )
    )
  );
  const data = queries.map((query) => query.data as SongListData<P>);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- queries unstable; their data is the key
  return useMemo(() => data, data);
}
