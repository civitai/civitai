import { dbWrite } from '~/server/db/client';
import { registerTextScanProfile } from '~/server/services/text-scan/profiles';
import type { TextScanField, TextScanSubject } from '~/server/services/text-scan/types';
import { MediaType } from '~/shared/utils/prisma/enums';

const titleOf = (metadata: unknown) => {
  const title = (metadata as { title?: unknown } | null)?.title;
  return typeof title === 'string' && title.trim() ? title : undefined;
};

// Never `notPublic`, even on a draft post: the song stays Pending until its lyrics verdict lands.
// The title rides along, so its level counts toward the song's (`songLevel`). A song with a title
// and no lyrics is scanned on its title alone, and never waits on that verdict.
registerTextScanProfile({
  entityType: 'TrackLyrics',
  labels: ['nsfw', 'csam'],
  load: async (ids) => {
    // primary: the lyrics are written just before their scan is submitted
    const rows = await dbWrite.trackLyrics.findMany({
      where: { imageId: { in: ids } },
      select: { imageId: true, text: true, image: { select: { userId: true, metadata: true } } },
    });
    const subjects = new Map<number, TextScanSubject>(
      rows.map((row) => {
        const title = titleOf(row.image.metadata);
        const fields: TextScanField[] = [
          ...(title ? [{ heading: 'Title', text: title }] : []),
          { heading: 'Lyrics', text: row.text },
        ];
        return [row.imageId, { userId: row.image.userId, declared: {}, fields }];
      })
    );
    const withoutLyrics = ids.filter((id) => !subjects.has(id));
    if (!withoutLyrics.length) return subjects;
    // primary: a title is written just before its scan is submitted
    const songs = await dbWrite.image.findMany({
      where: { id: { in: withoutLyrics }, type: MediaType.audio },
      select: { id: true, userId: true, metadata: true },
    });
    for (const song of songs) {
      const title = titleOf(song.metadata);
      if (title)
        subjects.set(song.id, {
          userId: song.userId,
          declared: {},
          fields: [{ heading: 'Title', text: title }],
        });
    }
    return subjects;
  },
});
