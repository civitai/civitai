import { NsfwLevel } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { registerTextScanProfile } from '~/server/services/text-scan/profiles';
import { isPublicModel, PUBLIC_MODEL_STATUSES } from '~/server/services/text-scan/public-content';
import type { TextScanSubject } from '~/server/services/text-scan/types';
import { Availability } from '~/shared/utils/prisma/enums';
import { removeTags } from '~/utils/string-helpers';

/**
 * Also read by the Model rules hold, so detection and rulings see the same model text. `publicOnly` loads
 * only what the public can see: a Published or Scheduled, non-Private model and its public versions.
 * `publicVersionsOnly` keeps every model but reads only its public versions, so a draft version's
 * text is scanned when it is published, not before. The default load returns a model whatever its
 * state, with every version, and marks it `notPublic`; only `scanEntity` skips it, so rulings and
 * the lab still read it. `prePublish` loads a model that is not public yet
 * as the post-publish scan will see it, so the two text hashes agree: any status, and the public
 * versions plus the ones this publish makes public.
 */
export async function loadModelScanSubjects(
  ids: number[],
  {
    publicOnly = false,
    publicVersionsOnly = publicOnly,
    prePublish,
  }: {
    publicOnly?: boolean;
    publicVersionsOnly?: boolean;
    prePublish?: { versionIds: number[] };
  } = {}
): Promise<Map<number, TextScanSubject>> {
  const publicVersions = { status: { in: PUBLIC_MODEL_STATUSES } };
  const rows = await dbWrite.model.findMany({
    where: {
      id: { in: ids },
      ...(prePublish ? {} : { deletedAt: null }),
      ...(publicOnly && !prePublish
        ? {
            status: { in: PUBLIC_MODEL_STATUSES },
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
      status: true,
      availability: true,
      modelVersions: {
        ...(prePublish
          ? { where: { OR: [publicVersions, { id: { in: prePublish.versionIds } }] } }
          : publicVersionsOnly
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
        // A prePublish load is the pre-publish text for a hash, not a scan, so it is never gated.
        ...(!prePublish && !isPublicModel(m) ? { notPublic: true } : {}),
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
  labels: ['nsfw', 'poi', 'minor', 'csam'],
  load: (ids) => loadModelScanSubjects(ids, { publicVersionsOnly: true }),
});
