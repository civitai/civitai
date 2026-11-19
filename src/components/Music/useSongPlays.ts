import { useMemo } from 'react';
import { useSongListReads } from '~/components/MusicPlayer/useSongListReads';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

/**
 * Play counts for a list of songs, by song id; a song the server could not answer for is absent.
 * Nothing is read with the music flag off.
 */
export function useSongListPlays(songIds: number[]) {
  const features = useFeatureFlags();
  const chunks = useSongListReads('getSongPlays', features.music ? songIds : []);
  return useMemo(
    (): Record<number, number> => Object.assign({}, ...chunks.map((data) => data ?? {})),
    [chunks]
  );
}
