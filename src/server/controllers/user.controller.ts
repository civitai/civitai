import { Context } from '~/server/createContext';
import { GetUserByUsernameSchema } from '~/server/schema/user.schema';
import { getUserModelStats } from '~/server/services/user.service';

export const getUserStatsHandler = async ({
  input,
  ctx,
}: {
  input: GetUserByUsernameSchema;
  ctx: Context;
}) => {
  const rankStats = await getUserModelStats({ input });

  return { rank: rankStats };
};
