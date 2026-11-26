import { dbWrite } from '~/server/db/client';
import { registerTextScanProfile } from '~/server/services/text-scan/profiles';
import type { TextScanField } from '~/server/services/text-scan/types';

const titleOf = (metadata: unknown) => {
  const title = (metadata as { title?: unknown } | null)?.title;
  return typeof title === 'string' && title.trim() ? title : undefined;
};

// Never `notPublic`, even on a draft post: the song stays Pending until its lyrics verdict lands.
// The title rides along, so its level counts toward the song's (`songLevel`).
registerTextScanProfile({
  entityType: 'TrackLyrics',
  labels: ['nsfw', 'csam'],
  load: async (ids) => {
    // primary: the lyrics are written just before their scan is submitted
    const rows = await dbWrite.trackLyrics.findMany({
      where: { imageId: { in: ids } },
      select: { imageId: true, text: true, image: { select: { userId: true, metadata: true } } },
    });
    return new Map(
      rows.map((row) => {
        const title = titleOf(row.image.metadata);
        const fields: TextScanField[] = [
          ...(title ? [{ heading: 'Title', text: title }] : []),
          { heading: 'Lyrics', text: row.text },
        ];
        return [row.imageId, { userId: row.image.userId, declared: {}, fields }];
      })
    );
  },
});
