import { prisma } from '~/server/db/client';
import { GetUserByUsernameSchema } from '~/server/schema/user.schema';

//https://github.com/civitai/civitai/discussions/8
export const getUserModelStats = async ({
  input: { username },
}: {
  input: GetUserByUsernameSchema;
}) => {
  const modelRanks = await prisma.modelRank.findMany({
    where: { model: { user: { username } } },
    select: {
      ratingAllTime: true,
      ratingCountAllTime: true,
      downloadCountAllTime: true,
    },
  });

  const ratings = modelRanks.reduce<number[]>(
    (acc, rank) => [...Array(rank.ratingCountAllTime)].map(() => rank.ratingAllTime).concat(acc),
    []
  );
  const avgRating = ratings.reduce((a, b) => a + b) / ratings.length;
  const totalDownloads = modelRanks.reduce((acc, val) => acc + val.downloadCountAllTime, 0);

  return {
    avgRating,
    totalDownloads,
  };
};
