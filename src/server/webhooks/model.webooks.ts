import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { getAllModelsWithVersionsSelect } from '~/server/selectors/model.selector';
import { getImagesForModelVersion } from '~/server/services/image.service';
import { getPrimaryFile } from '~/server/utils/model-helpers';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { createWebhookProcessor } from '~/server/webhooks/base.webhooks';

const baseUrl = getBaseUrl();
export const modelWebhooks = createWebhookProcessor({
  'new-model': {
    displayName: 'New Models',
    getData: async ({ lastSent, prisma }) => {
      const now = new Date();
      const models = await prisma.model.findMany({
        where: {
          OR: [
            {
              publishedAt: {
                gt: lastSent,
                lte: now,
              },
              status: 'Published',
            },
            {
              publishedAt: {
                lt: lastSent,
              },
              status: 'Scheduled',
            },
          ],
          deletedAt: null,
        },
        select: getAllModelsWithVersionsSelect,
      });
      if (!models.length) return [];

      const modelVersionIds = models.flatMap((model) => model.modelVersions.map((v) => v.id));
      const images = await getImagesForModelVersion({ modelVersionIds });

      const results = models?.map(({ modelVersions, tagsOnModels, user, ...model }) => ({
        ...model,
        creator: {
          username: user.username,
          image: user.image ? getEdgeUrl(user.image, { width: 96 }) : null,
        },
        tags: tagsOnModels.map(({ tag }) => tag.name),
        modelVersions: modelVersions
          .map(({ files, ...version }) => {
            const castedFiles = files as Array<
              Omit<(typeof files)[number], 'metadata'> & { metadata: FileMetadata }
            >;
            const primaryFile = getPrimaryFile(castedFiles);
            if (!primaryFile) return null;

            return {
              ...version,
              files: castedFiles.map((file) => ({
                ...file,
                downloadUrl: `${baseUrl}${createModelFileDownloadUrl({
                  versionId: version.id,
                  type: file.type,
                  meta: file.metadata,
                  primary: primaryFile.id === file.id,
                })}`,
              })),
              images: images
                .filter((x) => x.modelVersionId === version.id)
                .map(({ url, ...image }) => ({
                  url: getEdgeUrl(url, { width: 450 }),
                  ...image,
                })),
              downloadUrl: `${baseUrl}${createModelFileDownloadUrl({
                versionId: version.id,
                primary: true,
              })}`,
            };
          })
          .filter((x) => x),
      }));

      return results;
    },
  },
  'updated-model': {
    displayName: 'Updated Models',
    getData: async ({ lastSent, prisma }) => {
      const models = await prisma.model.findMany({
        where: {
          lastVersionAt: {
            gt: lastSent,
          },
          publishedAt: {
            lt: lastSent,
          },
          deletedAt: null,
        },
        select: getAllModelsWithVersionsSelect,
      });
      if (!models.length) return [];

      const modelVersionIds = models.flatMap((model) => model.modelVersions.map((v) => v.id));
      const images = await getImagesForModelVersion({ modelVersionIds });

      const results = models.map(({ modelVersions, tagsOnModels, user, ...model }) => ({
        ...model,
        creator: {
          username: user.username,
          image: user.image ? getEdgeUrl(user.image, { width: 96 }) : null,
        },
        tags: tagsOnModels.map(({ tag }) => tag.name),
        modelVersions: modelVersions
          .map(({ files, ...version }) => {
            const castedFiles = files as Array<
              Omit<(typeof files)[number], 'metadata'> & { metadata: FileMetadata }
            >;
            const primaryFile = getPrimaryFile(castedFiles);
            if (!primaryFile) return null;

            return {
              ...version,
              files: castedFiles.map((file) => ({
                ...file,
                downloadUrl: `${baseUrl}${createModelFileDownloadUrl({
                  versionId: version.id,
                  type: file.type,
                  meta: file.metadata,
                  primary: primaryFile.id === file.id,
                })}`,
              })),
              images: images
                .filter((x) => x.modelVersionId === version.id)
                .map(({ url, ...image }) => ({
                  url: getEdgeUrl(url, { width: 450 }),
                  ...image,
                })),
              downloadUrl: `${baseUrl}${createModelFileDownloadUrl({
                versionId: version.id,
                primary: true,
              })}`,
            };
          })
          .filter((x) => x),
      }));

      return results;
    },
  },
});
