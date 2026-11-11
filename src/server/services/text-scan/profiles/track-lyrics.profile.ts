import { dbWrite } from '~/server/db/client';
import { registerTextScanProfile } from '~/server/services/text-scan/profiles';

/**
 * Keyed by the song's `imageId`. Not `notPublic` while its post is a draft: lyrics are scanned when
 * the song is posted, so a hold exists before the post can be published.
 */
registerTextScanProfile({
  entityType: 'TrackLyrics',
  labels: ['nsfw', 'csam'],
  load: async (ids) => {
    const rows = await dbWrite.trackLyrics.findMany({
      where: { imageId: { in: ids } },
      select: { imageId: true, text: true, image: { select: { userId: true } } },
    });
    return new Map(
      rows.map((row) => [
        row.imageId,
        { userId: row.image.userId, declared: {}, fields: [{ heading: 'Lyrics', text: row.text }] },
      ])
    );
  },
});
