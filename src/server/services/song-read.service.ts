import { getImageIdsVisibleToViewer } from '~/server/services/image-visibility.service';

export type SongViewer = {
  user?: { id: number; isModerator?: boolean | null };
  features: { music?: boolean };
};

/** Whether songs can be read at all; for a caller that must decide before any other read. */
export function isMusicEnabled(features: SongViewer['features']) {
  return !!features.music;
}

/**
 * The one read every by-id song procedure goes through: the ids in `ids` the viewer may open, or
 * null with the music flag off, which each caller answers in its own way (refused, or empty).
 */
export async function getVisibleSongIds({
  ids,
  viewer,
}: {
  ids: number[];
  viewer: SongViewer;
}): Promise<Set<number> | null> {
  if (!isMusicEnabled(viewer.features)) return null;
  return getImageIdsVisibleToViewer({
    ids: [...new Set(ids)],
    userId: viewer.user?.id,
    isModerator: viewer.user?.isModerator ?? undefined,
  });
}
