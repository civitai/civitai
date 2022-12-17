import { getEdgeUrl } from '~/components/EdgeImage/EdgeImage';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { getAllModelsWithVersionsSelect } from '~/server/selectors/model.selector';
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
            const hasPrimary = files.findIndex((file) => file.primary) > -1;
            if (!hasPrimary) return null;

            return {
              ...version,
              files: files.map(({ primary, ...file }) => ({
                ...file,
                primary: primary === true ? primary : undefined,
                downloadUrl: `${baseUrl}${createModelFileDownloadUrl({
                  versionId: version.id,
                  type: file.type,
                  format: file.format,
                  primary,
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
