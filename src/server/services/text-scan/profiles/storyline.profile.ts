import { dbWrite } from '~/server/db/client';
import { registerTextScanProfile } from '~/server/services/text-scan/profiles';
import type { TextScanSubject } from '~/server/services/text-scan/types';

/**
 * What the scan reads of a storyline. Nothing is declared: an owner cannot rate or flag a title,
 * so any finding is new. Shared with the moderator's lift, which hashes the title it reviewed.
 */
export const storylineTextScanSubject = (s: {
  userId: number;
  title: string;
}): TextScanSubject => ({
  userId: s.userId,
  declared: {},
  fields: [{ heading: 'Title', text: s.title }],
});

registerTextScanProfile({
  entityType: 'Storyline',
  labels: ['nsfw', 'poi', 'minor'],
  load: async (ids) => {
    const rows = await dbWrite.storyline.findMany({
      where: { id: { in: ids } },
      select: { id: true, userId: true, title: true },
    });
    return new Map(rows.map((s) => [s.id, storylineTextScanSubject(s)]));
  },
});
