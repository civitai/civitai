import type { ModelHashType } from '~/shared/utils/prisma/enums';
import { ModelFileVisibility, ModelModifier } from '~/shared/utils/prisma/enums';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { isProd } from '~/env/other';
import { getDownloadFilename } from '~/server/services/file.service';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { dbRead } from '~/server/db/client';
import type { ModelVersionApiReturn } from '~/server/selectors/modelVersion.selector';
import { getModelVersionApiSelect } from '~/server/selectors/modelVersion.selector';
import { getImagesForModelVersion } from '~/server/services/image.service';
import { getVaeFiles } from '~/server/services/model.service';
import { MixedAuthEndpoint } from '~/server/utils/endpoint-helpers';
import { getPrimaryFile } from '~/server/utils/model-helpers';
import { reduceToBasicFileMetadata } from '~/server/services/model-file.service';
import type { Session } from 'next-auth';
import { stringifyAIR } from '~/shared/utils/air';
import { safeDecodeURIComponent } from '~/utils/string-helpers';
import { browsingLevels, sfwBrowsingLevelsArray } from '~/shared/constants/browsingLevel.constants';
import { getRegion, isRegionRestricted } from '~/server/utils/region-blocking';
import { getRequestDomainColor } from '~/shared/constants/domain.constants';

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
  const status = user?.isModerator ? undefined : 'Published';

  const region = getRegion(req);
  const isRestricted = isRegionRestricted(region);
  const domainColor = getRequestDomainColor(req);
  const allowedBrowsingLevels =
    isRestricted || domainColor === 'green' ? sfwBrowsingLevelsArray : [...browsingLevels];

  const modelVersion = await dbRead.modelVersion.findFirst({
    where: { id, status, nsfwLevel: { in: allowedBrowsingLevels } },
    select: getModelVersionApiSelect,
  });

  await resModelVersionDetails(req, res, modelVersion);
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
