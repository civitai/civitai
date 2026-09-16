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
  // 🔴 `username` is a STRING and must never be inferred. A Civitai username may
  // be entirely digits (`usernameSchema` is `/^[A-Za-z0-9_]*$/`), and inferring
  // the type from the stored text turned `'0222'` into `222` — a name that
  // matches no account — and `'2428023993'` into an unquoted JSON number that
  // no typed API client could decode. civitai#4768 / civitai/cli#513.
  //
  // `username` is NOT declared nullable, and that is deliberate: the column is
  // `NOT NULL`, and `'null'` is a name this regex allows someone to hold.
  fieldTypes: {
    userId: 'number',
    username: 'string',
    image: 'string?',
    deletedAt: 'date?',
  },
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
