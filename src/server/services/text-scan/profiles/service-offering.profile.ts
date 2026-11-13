import { dbWrite } from '~/server/db/client';
import { registerTextScanProfile } from '~/server/services/text-scan/profiles';
import { ServiceOfferingStatus } from '~/shared/utils/prisma/enums';

registerTextScanProfile({
  entityType: 'ServiceOffering',
  labels: ['nsfw'],
  load: async (ids) => {
    const rows = await dbWrite.serviceOffering.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        sellerId: true,
        title: true,
        description: true,
        declaredNsfwLevel: true,
        status: true,
      },
    });
    return new Map(
      rows.map((o) => [
        o.id,
        {
          userId: o.sellerId,
          declared: { nsfwLevel: o.declaredNsfwLevel },
          notPublic: o.status === ServiceOfferingStatus.Removed,
          fields: [
            { heading: 'Title', text: o.title },
            { heading: 'Description', text: o.description },
          ],
        },
      ])
    );
  },
});
