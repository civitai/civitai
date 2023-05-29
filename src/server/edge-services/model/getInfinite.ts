import { getModelVersionImages } from './getModelVersionImages';
import { getAll } from './getAll';
import { SessionUser } from 'next-auth';
import { GetAllOutput } from './schemas';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import { modelHashSelect } from '~/server/selectors/modelHash.selector';
import { ModelFileType } from '~/server/common/constants';
import { ModelHashType } from '@prisma/client';
import { isDefined } from '~/utils/type-guards';

export type GetInfiniteReturnType = AsyncReturnType<typeof getInfinite>;
export type ModelsInfinite = GetInfiniteReturnType['items'];
export type ModelsInfiniteItem = ModelsInfinite[number];
export const getInfinite = async ({
  currentUser,
  take,
  ...query
}: GetAllOutput & { currentUser?: SessionUser }) => {
  const models = await getAll(
    { ...query, currentUser, take: take + 1 },
    {
      id: true,
      name: true,
      type: true,
      nsfw: true,
      status: true,
      createdAt: true,
      lastVersionAt: true,
      publishedAt: true,
      locked: true,
      earlyAccessDeadline: true,
      rank: {
        select: {
          [`downloadCount${query.period}`]: true,
          [`favoriteCount${query.period}`]: true,
          [`commentCount${query.period}`]: true,
          [`ratingCount${query.period}`]: true,
          [`rating${query.period}`]: true,
        },
      },
      modelVersions: {
        orderBy: { index: 'asc' },
        take: 1,
        select: {
          id: true,
          earlyAccessTimeFrame: true,
          createdAt: true,
        },
      },
      tags: { select: { tagId: true } },
      user: { select: simpleUserSelect },
      hashes: {
        select: modelHashSelect,
        where: {
          hashType: ModelHashType.SHA256,
          fileType: { in: ['Model', 'Pruned Model'] as ModelFileType[] },
        },
      },
    }
  );

  const modelVersionIds = models.flatMap((x) => x.modelVersions).map((x) => x.id);
  const images = await getModelVersionImages({ modelVersionIds });

  let nextCursor: number | undefined;
  if (models.length > take) {
    const nextItem = models.pop();
    nextCursor = nextItem?.id;
  }

  return {
    nextCursor,
    items: models
      .map(({ hashes, modelVersions, rank, tags, ...model }) => {
        const [version] = modelVersions;
        if (!version) return null;
        const versionImages = images.filter((x) => x.modelVersionId === version.id);
        const showImageless =
          (currentUser?.isModerator || model.user.id === currentUser?.id) &&
          (query.user || query.username);
        if (!versionImages.length && !showImageless) return null;

        return {
          ...model,
          hashes: hashes.map((hash) => hash.hash.toLowerCase()),
          rank: {
            downloadCount: rank?.[`downloadCount${query.period}`] ?? 0,
            favoriteCount: rank?.[`favoriteCount${query.period}`] ?? 0,
            commentCount: rank?.[`commentCount${query.period}`] ?? 0,
            ratingCount: rank?.[`ratingCount${query.period}`] ?? 0,
            rating: rank?.[`rating${query.period}`] ?? 0,
          },
          images: versionImages,
          tags: tags.map((x) => x.tagId),
        };
      })
      .filter(isDefined),
  };
};
