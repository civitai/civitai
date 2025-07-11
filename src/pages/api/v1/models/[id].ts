import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod/v4';
import type { ModelHashType } from '~/shared/utils/prisma/enums';
import { ModelFileVisibility, ModelModifier } from '~/shared/utils/prisma/enums';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { ModelSort } from '~/server/common/enums';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { getDownloadFilename } from '~/server/services/file.service';
import { getModelsWithVersions } from '~/server/services/model.service';
import { PublicEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { getPrimaryFile } from '~/server/utils/model-helpers';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { removeEmpty } from '~/utils/object-helpers';
import { safeDecodeURIComponent } from '~/utils/string-helpers';

const hashesAsObject = (hashes: { type: ModelHashType; hash: string }[]) =>
  hashes.reduce((acc, { type, hash }) => ({ ...acc, [type]: hash }), {});

const schema = z.object({ id: z.coerce.number() });

const baseUrl = getBaseUrl();

export default PublicEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  const parsedParams = schema.safeParse(req.query);
  if (!parsedParams.success)
    return res
      .status(400)
      .json({ error: `Invalid id: ${parsedParams.error.issues[0].input as string}` });

  try {
    const { items } = await getModelsWithVersions({
      input: {
        ids: [parsedParams.data.id],
        sort: ModelSort.HighestRated,
        favorites: false,
        hidden: false,
        archived: true,
        period: 'AllTime',
        periodMode: 'published',
        browsingLevel: allBrowsingLevelsFlag,
      },
    });
    if (items.length === 0)
      return res.status(404).json({ error: `No model with id ${parsedParams.data.id}` });

    const { modelVersions, tagsOnModels, user, ...model } = items[0];

    res.status(200).json({
      ...model,
      mode: model.mode == null ? undefined : model.mode,
      creator: user
        ? {
            username: user.username,
            image: user.profilePicture
              ? getEdgeUrl(user.profilePicture.url, {
                  width: 96,
                  name: user.username,
                  type: user.profilePicture.type,
                })
              : user.image
              ? getEdgeUrl(user.image, { width: 96, name: user.username })
              : null,
          }
        : undefined,
      tags: tagsOnModels.map(({ name }) => name),
      modelVersions: modelVersions
        .filter((x) => x.status === 'Published')
        .map(({ images, files, ...version }) => {
          const castedFiles = files as Array<
            Omit<(typeof files)[number], 'metadata'> & { metadata: BasicFileMetadata }
          >;
          const primaryFile = getPrimaryFile(castedFiles);
          if (!primaryFile) return null;

          const includeDownloadUrl = model.mode !== ModelModifier.Archived;
          const includeImages = model.mode !== ModelModifier.TakenDown;

          return removeEmpty({
            ...version,
            files: includeDownloadUrl
              ? castedFiles
                  .filter((file) => file.visibility === ModelFileVisibility.Public)
                  .map(({ hashes, metadata, ...file }) => ({
                    ...file,
                    metadata: removeEmpty(metadata),
                    name: safeDecodeURIComponent(
                      getDownloadFilename({ model, modelVersion: version, file })
                    ),
                    hashes: hashesAsObject(hashes),
                    downloadUrl: `${baseUrl}${createModelFileDownloadUrl({
                      versionId: version.id,
                      type: file.type,
                      meta: metadata,
                      primary: primaryFile.id === file.id,
                    })}`,
                    primary: primaryFile.id === file.id ? true : undefined,
                    url: undefined,
                    visibility: undefined,
                  }))
              : [],
            images: includeImages
              ? images.map(({ url, id, ...image }) => ({
                  url: getEdgeUrl(url, {
                    width: image.width ?? 450,
                    name: id.toString(),
                    type: image.type,
                  }),
                  ...image,
                }))
              : [],
            downloadUrl: includeDownloadUrl
              ? `${baseUrl}${createModelFileDownloadUrl({
                  versionId: version.id,
                  primary: true,
                })}`
              : undefined,
          });
        })
        .filter((x) => x),
    });
  } catch (error) {
    return handleEndpointError(res, error);
  }
});
