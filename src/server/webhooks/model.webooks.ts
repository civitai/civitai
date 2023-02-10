import { getEdgeUrl } from '~/components/EdgeImage/EdgeImage';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { getAllModelsWithVersionsSelect } from '~/server/selectors/model.selector';
import { getPrimaryFile } from '~/server/utils/model-helpers';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { createWebhookProcessor } from '~/server/webhooks/base.webhooks';

const baseUrl = getBaseUrl();
export const modelWebhooks = createWebhookProcessor({
  'new-model': {
    displayName: 'New Models',
    getData: async ({ lastSent, prisma }) => {
      const models = (
        await prisma.model.findMany({
          where: {
            publishedAt: {
              gt: lastSent,
            },
            deletedAt: null,
          },
          select: getAllModelsWithVersionsSelect,
        })
      )?.map(({ modelVersions, tagsOnModels, user, ...model }) => ({
        ...model,
        creator: {
          username: user.username,
          image: user.image ? getEdgeUrl(user.image, { width: 96 }) : null,
        },
        tags: tagsOnModels.map(({ tag }) => tag.name),
        modelVersions: modelVersions
          .map(({ images, files, ...version }) => {
            const primaryFile = getPrimaryFile(files);
            if (!primaryFile) return null;

            return {
              ...version,
              files: files.map((file) => ({
                ...file,
                downloadUrl: `${baseUrl}${createModelFileDownloadUrl({
                  versionId: version.id,
                  type: file.type,
                  format: file.format,
                  primary: primaryFile.id === file.id,
                })}`,
              })),
              images: images.map(({ image: { url, ...image } }) => ({
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

      return models;
    },
  },
  'updated-model': {
    displayName: 'Updated Models',
    getData: async ({ lastSent, prisma }) => {
      const models = (
        await prisma.model.findMany({
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
        })
      )?.map(({ modelVersions, tagsOnModels, user, ...model }) => ({
        ...model,
        creator: {
          username: user.username,
          image: user.image ? getEdgeUrl(user.image, { width: 96 }) : null,
        },
        tags: tagsOnModels.map(({ tag }) => tag.name),
        modelVersions: modelVersions
          .map(({ images, files, ...version }) => {
            const primaryFile = getPrimaryFile(files);
            if (!primaryFile) return null;

            return {
              ...version,
              files: files.map((file) => ({
                ...file,
                downloadUrl: `${baseUrl}${createModelFileDownloadUrl({
                  versionId: version.id,
                  type: file.type,
                  format: file.format,
                  primary: primaryFile.id === file.id,
                })}`,
              })),
              images: images.map(({ image: { url, ...image } }) => ({
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

      return models;
    },
  },
});
