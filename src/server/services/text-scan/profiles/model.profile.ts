import { NsfwLevel } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { registerTextScanProfile } from '~/server/services/text-scan/profiles';
import { removeTags } from '~/utils/string-helpers';

registerTextScanProfile({
  entityType: 'Model',
  labels: ['nsfw', 'poi', 'minor'],
  load: async (ids) => {
    const rows = await dbWrite.model.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: {
        id: true,
        userId: true,
        name: true,
        description: true,
        nsfw: true,
        poi: true,
        minor: true,
        modelVersions: {
          select: { name: true, description: true, trainedWords: true },
          orderBy: { index: 'asc' },
        },
      },
    });
    return new Map(
      rows.map((m) => [
        m.id,
        {
          userId: m.userId,
          declared: {
            nsfwLevel: m.nsfw ? NsfwLevel.XXX : NsfwLevel.PG13,
            poi: m.poi,
            minor: m.minor,
          },
          fields: [
            { heading: 'Name', text: m.name },
            { heading: 'Description', text: m.description ? removeTags(m.description) : null },
            ...m.modelVersions.flatMap((v) => [
              { heading: 'Version name', text: v.name },
              {
                heading: 'Version description',
                text: v.description ? removeTags(v.description) : null,
              },
              { heading: 'Trained words', text: v.trainedWords.join(', ') },
            ]),
          ],
        },
      ])
    );
  },
});
