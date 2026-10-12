import { NsfwLevel } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { registerTextScanProfile } from '~/server/services/text-scan/profiles';
import type { TextScanSubject } from '~/server/services/text-scan/types';
import { Availability, ModelStatus } from '~/shared/utils/prisma/enums';

const PUBLIC_STATUSES = [ModelStatus.Published, ModelStatus.Scheduled];
import { removeTags } from '~/utils/string-helpers';

/**
 * Shared with the `ModelRules` profile, so both scans read the same model text. `publicOnly` loads
 * only what the public can see: a Published or Scheduled, non-Private model and its public versions.
 * `prePublish` loads a model that is not public yet as the post-publish scan will see it, so the two
 * text hashes agree: any status, and the public versions plus the ones this publish makes public.
 */
export async function loadModelScanSubjects(
  ids: number[],
  {
    publicOnly = false,
    prePublish,
  }: { publicOnly?: boolean; prePublish?: { versionIds: number[] } } = {}
): Promise<Map<number, TextScanSubject>> {
  const publicVersions = { status: { in: PUBLIC_STATUSES } };
  const rows = await dbWrite.model.findMany({
    where: {
      id: { in: ids },
      ...(prePublish ? {} : { deletedAt: null }),
      ...(publicOnly && !prePublish
        ? {
            status: { in: PUBLIC_STATUSES },
            availability: { not: Availability.Private },
          }
        : {}),
    },
    select: {
      id: true,
      userId: true,
      name: true,
      description: true,
      nsfw: true,
      poi: true,
      minor: true,
      modelVersions: {
        ...(prePublish
          ? { where: { OR: [publicVersions, { id: { in: prePublish.versionIds } }] } }
          : publicOnly
          ? { where: publicVersions }
          : {}),
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
}

registerTextScanProfile({
  entityType: 'Model',
  labels: ['nsfw', 'poi', 'minor'],
  load: (ids) => loadModelScanSubjects(ids),
});
