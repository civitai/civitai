import { PGlite } from '@electric-sql/pglite';
import { TRPCError } from '@trpc/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({
  db: null as unknown as PGlite,
  issued: [] as { key: string; userId: number }[],
  logDown: false,
}));

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: {
    $query: async (sql: string) => {
      if (holder.logDown) throw new Error('unavailable');
      const alias = sql.match(/any\(userId\) AS (\w+)/)?.[1] ?? 'owner';
      return holder.issued
        .filter(({ key }) => sql.includes(`'${key}'`))
        .map(({ key, userId }) => ({ key, [alias]: userId }));
    },
  },
}));

dbMock.dbWrite.$queryRaw.mockImplementation(((
  ...a: Parameters<ReturnType<typeof pgliteRaw>['queryRaw']>
) => pgliteRaw(holder.db).queryRaw(...a)) as never);
dbMock.dbWrite.$executeRaw.mockImplementation(((
  ...a: Parameters<ReturnType<typeof pgliteRaw>['executeRaw']>
) => pgliteRaw(holder.db).executeRaw(...a)) as never);

const {
  assertClientKeysIssuedToCaller,
  assertShopArtworkKeysIssued,
  recordUploadKeyOwner,
  UNRECORDED_KEYS_ACCEPTED_UNTIL,
} = await import('~/server/services/image-url-ownership');

const CREATOR = 7;
const OTHER = 8;
const MODERATOR = 9;
const KEY = 'ab12cd34-ef56-4a7b-8c9d-0e1f2a3b4c5d';
const URL = `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${KEY}/original=true/art.png`;
const BEFORE = new Date(UNRECORDED_KEYS_ACCEPTED_UNTIL.getTime() - 60_000);

const redis = new Map<string, string>();

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Image" ("id" serial PRIMARY KEY, "userId" integer NOT NULL, "url" text NOT NULL);
    CREATE TABLE "ShopArtworkKeyOwner" (
      key text PRIMARY KEY, "userId" integer NOT NULL, "recordedAt" timestamp(3) NOT NULL DEFAULT now()
    );
  `);
});

beforeEach(async () => {
  await holder.db.exec(`TRUNCATE "Image", "ShopArtworkKeyOwner"`);
  holder.issued = [];
  holder.logDown = false;
  redis.clear();
  redisMock.sysRedis.set.mockImplementation((async (key: string, value: string) => {
    redis.set(key, value);
    return 'OK';
  }) as never);
  redisMock.sysRedis.mGet.mockImplementation((async (keys: string[]) =>
    keys.map((k) => redis.get(k) ?? null)) as never);
});

const outcome = (args: { userId: number; alsoIssuedTo?: number; url?: string }) =>
  assertShopArtworkKeysIssued({ urls: [args.url ?? KEY], ...args }).then(
    () => 'accepted',
    (e: unknown) => {
      if (e instanceof TRPCError && e.code === 'BAD_REQUEST') return 'refused';
      throw e;
    }
  );

const kept = async () =>
  (
    await holder.db.query<{ key: string; userId: number }>(
      `SELECT key, "userId" FROM "ShopArtworkKeyOwner"`
    )
  ).rows;

/** The issue record and the upload request log both lose the key. */
const forgetIssue = () => {
  redis.clear();
  holder.issued = [];
};

describe('assertShopArtworkKeysIssued', () => {
  it("accepts the creator's own key and keeps its owner", async () => {
    await recordUploadKeyOwner(KEY, CREATOR);
    expect(await outcome({ userId: CREATOR })).toBe('accepted');
    expect(await kept()).toEqual([{ key: KEY, userId: CREATOR }]);
  });

  it('refuses a key issued to another user, and keeps nothing', async () => {
    await recordUploadKeyOwner(KEY, OTHER);
    expect(await outcome({ userId: CREATOR })).toBe('refused');
    expect(await kept()).toEqual([]);
  });

  it('refuses a key the upload request log issued to another user', async () => {
    holder.issued = [{ key: KEY, userId: OTHER }];
    expect(await outcome({ userId: CREATOR })).toBe('refused');
  });

  it("does not take the saver's own Image row as proof", async () => {
    await holder.db.query(`INSERT INTO "Image" ("userId", url) VALUES ($1, $2), ($1, $3)`, [
      CREATOR,
      KEY,
      URL,
    ]);
    expect(await outcome({ userId: CREATOR })).toBe('refused');
  });

  it('refuses a key with no record before the cutoff, which the other image checks still accept', async () => {
    expect(await outcome({ userId: CREATOR })).toBe('refused');
    expect(await kept()).toEqual([]);
    await expect(
      assertClientKeysIssuedToCaller({ urls: [KEY], userId: CREATOR, now: BEFORE })
    ).resolves.toBeUndefined();
  });

  it('proves a kept key after the record and the log lose it', async () => {
    await recordUploadKeyOwner(KEY, CREATOR);
    await outcome({ userId: CREATOR });
    forgetIssue();
    expect(await outcome({ userId: CREATOR })).toBe('accepted');
    expect(await outcome({ userId: OTHER })).toBe('refused');
  });

  it("accepts the creator's key on a moderator's edit, and keeps the creator as owner", async () => {
    await recordUploadKeyOwner(KEY, CREATOR);
    expect(await outcome({ userId: MODERATOR, alsoIssuedTo: CREATOR })).toBe('accepted');
    expect(await kept()).toEqual([{ key: KEY, userId: CREATOR }]);
    expect(await outcome({ userId: MODERATOR })).toBe('refused');
  });

  it('refuses a logged key when neither the record nor the log can be read', async () => {
    holder.issued = [{ key: KEY, userId: CREATOR }];
    holder.logDown = true;
    redisMock.sysRedis.mGet.mockRejectedValueOnce(new Error('unavailable'));
    expect(await outcome({ userId: CREATOR })).toBe('refused');
  });

  it('accepts a logged key when the issue record cannot be read', async () => {
    holder.issued = [{ key: KEY, userId: CREATOR }];
    redisMock.sysRedis.mGet.mockRejectedValueOnce(new Error('unavailable'));
    expect(await outcome({ userId: CREATOR })).toBe('accepted');
  });

  it('refuses more upload keys than one check takes', async () => {
    const keys = Array.from(
      { length: 65 },
      (_, i) => `${KEY.slice(0, -4)}${String(i).padStart(4, '0')}`
    );
    for (const key of keys) await recordUploadKeyOwner(key, CREATOR);
    const check = (urls: string[]) =>
      assertShopArtworkKeysIssued({ urls, userId: CREATOR }).then(
        () => 'accepted',
        () => 'refused'
      );
    expect(await check(keys)).toBe('refused');
    expect(await check(keys.slice(0, 64))).toBe('accepted');
  });

  it.each([
    ['a url with no upload key', 'https://example.com/art.png'],
    ['a url carrying the key', URL],
    ['the key in capitals', KEY.toUpperCase()],
    ['two keys', `${KEY}/${KEY.replace('ab12', 'ab13')}`],
  ])('refuses %s, even with the key issued to the saver', async (_, url) => {
    await recordUploadKeyOwner(KEY, CREATOR);
    expect(await outcome({ userId: CREATOR, url })).toBe('refused');
  });
});
