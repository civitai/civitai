import { createCache, CacheContext } from './base';

export type UserCacheData = {
  userId: number;
  username: string;
  image?: string;
  deletedAt?: Date | null;
  // Add other user fields as needed
};

/**
 * Cache for user data
 * Used to populate documents with user information (username, avatar, etc.)
 */
export const userData = createCache<UserCacheData>({
  redisKey: 'user:data',
  idKey: 'userId',
  async fetch({ pg }: CacheContext, ids: number[]) {
    const users = await pg.query<UserCacheData>(
      `SELECT
        id as "userId",
        username,
        image,
        "deletedAt"
       FROM "User"
       WHERE id = ANY($1)`,
      [ids]
    );
    return users;
  },
  ttl: 60 * 60 * 24, // 24 hours
});
