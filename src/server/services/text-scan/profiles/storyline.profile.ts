import { dbWrite } from '~/server/db/client';
import { registerTextScanProfile } from '~/server/services/text-scan/profiles';

// Nothing is declared: an owner cannot rate or flag a title, so any finding is new.
registerTextScanProfile({
  entityType: 'Storyline',
  labels: ['nsfw', 'poi', 'minor'],
  load: async (ids) => {
    const rows = await dbWrite.storyline.findMany({
      where: { id: { in: ids } },
      select: { id: true, userId: true, title: true },
    });
    return new Map(
      rows.map((s) => [
        s.id,
        { userId: s.userId, declared: {}, fields: [{ heading: 'Title', text: s.title }] },
      ])
    );
  },
});
