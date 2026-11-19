import { dbWrite } from '~/server/db/client';
import { registerTextScanProfile } from '~/server/services/text-scan/profiles';
import type { TextScanSubject } from '~/server/services/text-scan/types';
import { ServiceOfferingStatus } from '~/shared/utils/prisma/enums';

export const loadServiceOfferingSubjects = async (
  ids: number[]
): Promise<Map<number, TextScanSubject>> => {
  const rows = await dbWrite.serviceOffering.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      sellerId: true,
      title: true,
      description: true,
      declaredNsfwLevel: true,
      maxNsfwLevel: true,
      status: true,
    },
  });
  return new Map(
    rows.map((o) => [
      o.id,
      {
        userId: o.sellerId,
        declared: { nsfwLevel: o.declaredNsfwLevel ?? o.maxNsfwLevel },
        notPublic: o.status === ServiceOfferingStatus.Removed,
        fields: [
          { heading: 'Title', text: o.title },
          { heading: 'Description', text: o.description },
        ],
      },
    ])
  );
};

registerTextScanProfile({
  entityType: 'ServiceOffering',
  labels: ['nsfw', 'csam'],
  load: loadServiceOfferingSubjects,
});
