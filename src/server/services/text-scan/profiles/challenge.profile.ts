import { dbWrite } from '~/server/db/client';
import { parseChallengeMetadata } from '~/server/schema/challenge.schema';
import { registerTextScanProfile } from '~/server/services/text-scan/profiles';
import { removeTags } from '~/utils/string-helpers';

registerTextScanProfile({
  entityType: 'Challenge',
  labels: ['nsfw'],
  load: async (ids) => {
    const rows = await dbWrite.challenge.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        createdById: true,
        title: true,
        theme: true,
        description: true,
        invitation: true,
        metadata: true,
        nsfwLevel: true,
      },
    });
    return new Map(
      rows.map((c) => [
        c.id,
        {
          userId: c.createdById ?? undefined,
          declared: { nsfwLevel: c.nsfwLevel },
          fields: [
            { heading: 'Title', text: c.title },
            { heading: 'Theme', text: c.theme },
            {
              heading: 'Theme elements',
              text: parseChallengeMetadata(c.metadata).themeElements?.join(', ') ?? null,
            },
            { heading: 'Description', text: c.description ? removeTags(c.description) : null },
            { heading: 'Invitation', text: c.invitation },
          ],
        },
      ])
    );
  },
});
