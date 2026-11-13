import { dbWrite } from '~/server/db/client';
import { registerTextScanProfile } from '~/server/services/text-scan/profiles';

// Never `notPublic`, even on a draft post: the song stays Pending until its lyrics verdict lands.
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
