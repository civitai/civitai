import { dbWrite } from '~/server/db/client';
import { registerTextScanProfile } from '~/server/services/text-scan/profiles';
import type { TextScanSubject } from '~/server/services/text-scan/types';

/** Keyed by `imageId`. Nothing is declared: an author cannot rate or flag a caption. */
export const imageCaptionTextScanSubject = (c: {
  userId: number;
  content: string;
}): TextScanSubject => ({
  userId: c.userId,
  declared: {},
  fields: [{ heading: 'Caption', text: c.content }],
});

registerTextScanProfile({
  entityType: 'ImageCaption',
  labels: ['nsfw', 'poi', 'minor'],
  load: async (ids) => {
    const rows = await dbWrite.imageCaption.findMany({
      where: { imageId: { in: ids } },
      select: { imageId: true, userId: true, content: true },
    });
    return new Map(rows.map((c) => [c.imageId, imageCaptionTextScanSubject(c)]));
  },
});
