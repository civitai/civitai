import { Prisma } from '@prisma/client';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { Session } from 'next-auth';
import * as z from 'zod';
import type { BaseModel } from '~/shared/constants/base-model.constants';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { dbRead } from '~/server/db/client';
import {
  getShouldChargeForResources,
  getUnavailableResources,
} from '~/server/services/generation/generation.service';
import { getFeaturedModels } from '~/server/services/model.service';
import { MixedAuthEndpoint } from '~/server/utils/endpoint-helpers';
import { getPrimaryFile } from '~/server/utils/model-helpers';
import { getBaseUrl } from '~/server/utils/url-helpers';
import type { ModelType } from '~/shared/utils/prisma/enums';
import { Availability, ModelUsageControl } from '~/shared/utils/prisma/enums';
import { stringifyAIR } from '~/shared/utils/air';

const schema = z.object({ id: z.coerce.number(), epoch: z.number().optional() });

type VersionRow = {
  id: number;
  versionName: string;
  availability: Availability;
  publishedAt: Date | null;
  modelId: number;
  modelName: string;
  baseModel: BaseModel;
  status: string;
  type: ModelType;
  earlyAccessEndsAt?: Date;
  requireAuth: boolean;
  checkPermission: boolean;
  covered?: boolean;
  freeTrialLimit?: number;
  minor: boolean;
  sfwOnly: boolean;
  usageControl: ModelUsageControl;
};
type FileRow = {
  id: number;
  type: string;
  visibility: string;
  url: string;
  metadata: FileMetadata;
  sizeKB: number;
  hash: string;
  name: string;
};

export default MixedAuthEndpoint(async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  user: Session['user'] | undefined
) {
  const results = schema.safeParse(req.query);
  if (!results.success)
    return res.status(400).json({ error: z.prettifyError(results.error) ?? 'Invalid id' });

  const { id } = results.data;
  if (!id) return res.status(400).json({ error: 'Missing modelVersionId' });
  const where = [Prisma.sql`mv.id = ${id}`];
  if (!user?.isModerator)
    where.push(Prisma.sql`(mv.status = 'Published' OR m."userId" = ${user?.id})`);

  const [modelVersion] = await dbRead.$queryRaw<VersionRow[]>`
    SELECT
      mv.id,
      mv.name as "versionName",
      "modelId",
      m.name as "modelName",
      mv."baseModel",
      mv.status,
      mv.availability,
      mv."publishedAt",
      m.type,
      m.minor,
      m."sfwOnly",
      mv."earlyAccessEndsAt",
      mv."requireAuth",
      mv."usageControl",
      (
        (
            mv."earlyAccessEndsAt" > NOW()
            AND mv."availability" = 'EarlyAccess'
            AND (mv."earlyAccessConfig"->>'freeGeneration' IS NULL OR mv."earlyAccessConfig"->>'freeGeneration' != 'true')
        )
        OR
        (mv."availability" = 'Private')
        OR
        (m."availability" = 'Private')

      ) AS "checkPermission",
      (SELECT covered FROM "GenerationCoverage" WHERE "modelVersionId" = mv.id) AS "covered",
      (
        CASE
          mv."earlyAccessConfig"->>'chargeForGeneration'
        WHEN 'true'
        THEN
          COALESCE(CAST(mv."earlyAccessConfig"->>'generationTrialLimit' AS int), 10)
        ELSE
          NULL
        END
      ) AS "freeTrialLimit"
    FROM "ModelVersion" mv
    JOIN "Model" m ON m.id = mv."modelId"
    WHERE ${Prisma.join(where, ' AND ')}
  `;
  if (!modelVersion) return res.status(404).json({ error: 'Model not found' });

  const files = await dbRead.$queryRaw<FileRow[]>`
    SELECT mf.id, mf.type, mf.visibility, mf.url, mf.metadata, mf."sizeKB", mfh.hash, mf.name
    FROM "ModelFile" mf
    LEFT JOIN "ModelFileHash" mfh ON mfh."fileId" = mf.id AND mfh.type = 'AutoV2'
    WHERE mf."modelVersionId" = ${id}
  `;

  const primaryFile = getPrimaryFile(files);
  if (!primaryFile) return res.status(404).json({ error: 'Missing model file' });

  const baseUrl = getBaseUrl();
  let air: string;
  let downloadUrl: string;

  if (
    modelVersion.availability === Availability.Private &&
    !!primaryFile.metadata.trainingResults
  ) {
    const epoch =
      primaryFile.metadata.trainingResults.epochs?.find((e) => {
        if ('epoch_number' in e) {
          return e.epoch_number === results.data.epoch;
        }

        return e.epochNumber === results.data.epoch;
      }) ?? primaryFile.metadata.trainingResults.epochs?.pop();

    if (!epoch) {
      return res.status(404).json({ error: 'Missing epoch' });
    }

    downloadUrl = 'epoch_number' in epoch ? epoch.model_url : epoch.modelUrl;
    const jobFileUrl = downloadUrl.split('/jobs/')[1]; // Leaves you with: ${jobId}/assets/${fileName}
    const jobId = jobFileUrl.split('/assets/')[0];
    const fileName = jobFileUrl.split('/assets/')[1];

    if (!jobId || !fileName) {
      return res.status(404).json({ error: 'Could not get jobId or fileName' });
    }

    air = stringifyAIR({
      ...modelVersion,
      source: 'orchestrator',
      modelId: jobId,
      id: fileName,
    });
  } else {
    // this does not work for things like Flux
    // if (primaryFile.type !== 'Model') return res.status(404).json({ error: 'File is not a model' });

    air = stringifyAIR(modelVersion);
    downloadUrl = `${baseUrl}${createModelFileDownloadUrl({
      versionId: modelVersion.id,
      primary: true,
    })}`;
  }

  // if req url domain contains `api.`, strip /api/ from the download url
  if (req.headers.host?.includes('api.')) {
    downloadUrl = downloadUrl.replace('/api/', '/').replace('civitai.com', 'api.civitai.com');
  }
  const { format } = primaryFile.metadata;

  // Check unavailable resources:
  let canGenerate = modelVersion.covered ?? false;
  if (canGenerate) {
    const unavailableResources = await getUnavailableResources();
    const isUnavailable = unavailableResources.some((r) => r === modelVersion.id);
    if (isUnavailable) canGenerate = false;

    // Only allow people with the right permission to generate with this model
    if (modelVersion.usageControl === ModelUsageControl.InternalGeneration && !user?.isModerator) {
      canGenerate = false;
    }
  }

  // Check if should charge
  const shouldChargeResult = await getShouldChargeForResources([
    {
      modelType: modelVersion.type,
      modelId: modelVersion.modelId,
      fileSizeKB: primaryFile.sizeKB,
    },
  ]);

  const isFeatured = (await getFeaturedModels())
    .map((fm) => fm.modelId)
    .includes(modelVersion.modelId);

  const data = {
    air,
    versionName: modelVersion.versionName,
    modelName: modelVersion.modelName,
    baseModel: modelVersion.baseModel,
    availability: modelVersion.availability,
    publishedAt: modelVersion.publishedAt,
    size: primaryFile.sizeKB, // nullable
    fileType: primaryFile.type,
    fileName: primaryFile.name,
    // nullable - hashes
    hashes: {
      AutoV2: primaryFile.hash, // nullable
    },
    downloadUrls: [downloadUrl], // nullable
    format, // nullable
    canGenerate,
    isFeatured,
    requireAuth: modelVersion.requireAuth,
    checkPermission: modelVersion.checkPermission,
    earlyAccessEndsAt: modelVersion.checkPermission ? modelVersion.earlyAccessEndsAt : undefined,
    freeTrialLimit: modelVersion.checkPermission ? modelVersion.freeTrialLimit : undefined,
    additionalResourceCharge: shouldChargeResult[modelVersion.modelId],
    minor: modelVersion.minor,
    sfwOnly: modelVersion.sfwOnly,
  };
  res.status(200).json(data);
});
