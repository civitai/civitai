import { dbWrite } from '~/server/db/client';
import { registerTextScanProfile } from '~/server/services/text-scan/profiles';
import type { TextScanSubject } from '~/server/services/text-scan/types';
import { removeTags } from '~/utils/string-helpers';

/** Keyed by `PostText.id`. Nothing is declared: an author cannot rate or flag a text item. */
export const postTextTextScanSubject = (t: {
  userId: number;
  content: string;
}): TextScanSubject => ({
  userId: t.userId,
  declared: {},
  fields: [{ heading: 'Text', text: removeTags(t.content) }],
});

registerTextScanProfile({
  entityType: 'PostText',
  labels: ['nsfw', 'csam', 'poi', 'minor'],
  load: async (ids) => {
    const rows = await dbWrite.postText.findMany({
      where: { id: { in: ids } },
      select: { id: true, userId: true, content: true },
    });
    return new Map(rows.map((t) => [t.id, postTextTextScanSubject(t)]));
  },
});
