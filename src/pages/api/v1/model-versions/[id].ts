import { Prisma } from '@prisma/client';
import type { ModelHashType } from '~/shared/utils/prisma/enums';
import { ModelFileVisibility, ModelModifier, ModelStatus } from '~/shared/utils/prisma/enums';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { isProd } from '~/env/other';
import { getDownloadFilename } from '~/server/services/file.service';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { dbRead } from '~/server/db/client';
import type { ModelVersionApiReturn } from '~/server/selectors/modelVersion.selector';
import { getImagesForModelVersion } from '~/server/services/image.service';
import { getVaeFiles } from '~/server/services/model.service';
import { MixedAuthEndpoint } from '~/server/utils/endpoint-helpers';
import { getPrimaryFile } from '~/server/utils/model-helpers';
import { reduceToBasicFileMetadata } from '~/server/services/model-file.service';
import type { Session } from 'next-auth';
import { stringifyAIR } from '~/shared/utils/air';
import { safeDecodeURIComponent } from '~/utils/string-helpers';
import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { getRegion, isRegionRestricted } from '~/server/utils/region-blocking';
import { getRequestDomainColor } from '~/shared/constants/domain.constants';
import { logToAxiom } from '~/server/logging/client';

const hashesAsObject = (hashes: { type: ModelHashType; hash: string }[]) =>
  hashes.reduce((acc, { type, hash }) => ({ ...acc, [type]: hash }), {});

const schema = z.object({ id: z.preprocess((val) => Number(val), z.number()) });
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
  const status = user?.isModerator ? undefined : ModelStatus.Published;

  const region = getRegion(req);
  const isRestricted = isRegionRestricted(region);
  const domainColor = getRequestDomainColor(req);
  const allowedBrowsingLevels =
    isRestricted || domainColor === 'green' ? sfwBrowsingLevelsFlag : allBrowsingLevelsFlag;

  try {
    const modelVersion = await dbRead.$queryRaw<ModelVersionApiReturn[]>`
      SELECT
        mv.id,
        mv."modelId",
        mv.name,
        mv."nsfwLevel",
        mv."createdAt",
        mv."updatedAt",
        mv.status,
        mv."publishedAt",
        mv."trainedWords",
        mv."trainingStatus",
        mv."trainingDetails",
        mv."baseModel",
        mv."baseModelType",
        mv."earlyAccessEndsAt",
        mv."earlyAccessConfig",
        mv.description,
        mv."vaeId",
        mv."uploadType",
        mv."usageControl",
        COALESCE(
          (
            SELECT json_agg(
              json_build_object(
                'downloadCount', m."downloadCount",
                'ratingCount', m."ratingCount",
                'rating', m.rating,
                'thumbsUpCount', m."thumbsUpCount",
                'thumbsDownCount', m."thumbsDownCount"
              )
            )
            FROM "ModelVersionMetric" m
            WHERE m."modelVersionId" = mv.id AND m.timeframe = 'AllTime'
          ),
          '[]'::json
        ) as metrics,
        COALESCE(
          (
            SELECT json_agg(
              json_build_object(
                'id', mf.id,
                'url', mf.url,
                'sizeKB', mf."sizeKB",
                'name', mf.name,
                'type', mf.type,
                'visibility', mf.visibility,
                'metadata', mf.metadata,
                'pickleScanResult', mf."pickleScanResult",
                'pickleScanMessage', mf."pickleScanMessage",
                'virusScanResult', mf."virusScanResult",
                'virusScanMessage', mf."virusScanMessage",
                'scannedAt', mf."scannedAt",
                'modelVersionId', mf."modelVersionId",
                'hashes', COALESCE(
                  (
                    SELECT json_agg(
                      json_build_object(
                        'type', h.type,
                        'hash', h.hash
                      )
                    )
                    FROM "ModelFileHash" h
                    WHERE h."fileId" = mf.id
                  ),
                  '[]'::json
                )
              )
            )
            FROM "ModelFile" mf
            WHERE mf."modelVersionId" = mv.id
          ),
          '[]'::json
        ) as files,
        (
          SELECT json_build_object(
            'name', m.name,
            'type', m.type,
            'nsfw', m.nsfw,
            'poi', m.poi,
            'mode', m.mode
          )
          FROM "Model" m
          WHERE m.id = mv."modelId"
        ) as model
      FROM "ModelVersion" mv
      WHERE mv.id = ${id}
        ${status ? Prisma.sql`AND mv.status = ${status}::"ModelStatus"` : Prisma.empty}
        AND (mv."nsfwLevel" & ${allowedBrowsingLevels}) != 0
      LIMIT 1
    `.then((results) => results[0] || null);

    await resModelVersionDetails(req, res, modelVersion);
  } catch (e) {
    const error = e as Error;
    logToAxiom({
      type: 'error',
      name: 'api-model-version-details',
      message: error.message,
      cause: error.cause,
      stack: error.stack,
    });

    return res.status(500).json({ error: 'Failed to fetch model version details' });
  }
});

export async function prepareModelVersionResponse(
  modelVersion: ModelVersionApiReturn,
  baseUrl: URL,
  images?: AsyncReturnType<typeof getImagesForModelVersion>
) {
  const { files, model, metrics, vaeId, ...version } = modelVersion;
  const vae = !!vaeId ? await getVaeFiles({ vaeIds: [vaeId] }) : [];
  files.push(...vae);
  const castedFiles = files as Array<
    Omit<(typeof files)[number], 'metadata'> & { metadata: FileMetadata }
  >;
  const primaryFile = getPrimaryFile(castedFiles);
  if (!primaryFile) return null;

  images ??= await getImagesForModelVersion({
    modelVersionIds: [version.id],
    include: ['meta'],
    imagesPerVersion: 10,
  });
  const includeDownloadUrl = model.mode !== ModelModifier.Archived;
  const includeImages = model.mode !== ModelModifier.TakenDown;

  return {
    ...version,
    air: stringifyAIR({
      baseModel: version.baseModel,
      type: model.type,
      modelId: version.modelId,
      id: version.id,
    }),
    stats: {
      downloadCount: metrics[0]?.downloadCount ?? 0,
      ratingCount: metrics[0]?.ratingCount ?? 0,
      rating: Number(metrics[0]?.rating?.toFixed(2) ?? 0),
      thumbsUpCount: metrics[0]?.thumbsUpCount ?? 0,
    },
    model: { ...model, mode: model.mode == null ? undefined : model.mode },
    files: includeDownloadUrl
      ? castedFiles
          .filter((file) => file.visibility === ModelFileVisibility.Public)
          .map(({ hashes, url, visibility, metadata, modelVersionId, ...file }) => ({
            ...file,
            metadata: reduceToBasicFileMetadata(metadata),
            hashes: hashesAsObject(hashes),
            name: safeDecodeURIComponent(
              getDownloadFilename({ model, modelVersion: version, file })
            ),
            primary: primaryFile.id === file.id,
            downloadUrl: `${baseUrl.origin}${createModelFileDownloadUrl({
              versionId: version.id,
              type: file.type,
              meta: metadata,
              primary: primaryFile.id === file.id,
            })}`,
          }))
      : [],
    images: includeImages
      ? images.map(({ url, id, userId, name, modelVersionId, ...image }) => ({
          url: getEdgeUrl(url, {
            original: true,
            name: id.toString(),
            type: image.type,
          }),
          ...image,
        }))
      : [],
    downloadUrl: includeDownloadUrl
      ? `${baseUrl.origin}${createModelFileDownloadUrl({
          versionId: version.id,
          primary: true,
        })}`
      : undefined,
  };
}

export async function resModelVersionDetails(
  req: NextApiRequest,
  res: NextApiResponse,
  modelVersion: ModelVersionApiReturn | null
) {
  if (!modelVersion) return res.status(404).json({ error: 'Model not found' });

  const baseUrl = new URL(
    isProd && req.headers.host ? `https://${req.headers.host}` : 'http://localhost:3000'
  );
  const body = await prepareModelVersionResponse(modelVersion, baseUrl);
  if (!body) return res.status(404).json({ error: 'Missing model file' });
  res.status(200).json(body);
}
