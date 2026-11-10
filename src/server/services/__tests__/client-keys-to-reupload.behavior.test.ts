import { PGlite } from '@electric-sql/pglite';
import { TRPCError } from '@trpc/server';
import type { Mock } from 'vitest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import * as prom from '~/server/prom/client';
import { BATCH_DRAFT_KEYS_PER_CHECK, checkBatchDraftKeysSchema } from '~/server/schema/post.schema';

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
  ...a: Parameters<ReturnType<typeof pgliteRaw>['queryRaw']>
) => pgliteRaw(holder.db).queryRaw(...a)) as never);

const {
  assertClientKeysIssuedToCaller,
  clientKeysToReupload,
  MAX_KEYS,
  recordUploadKeyOwner,
  UNRECORDED_KEYS_ACCEPTED_UNTIL,
} = await import('~/server/services/image-url-ownership');

// The setup file stubs every registered metric; this is the stub the module built for its counter.
const counterAt = vi
  .mocked(prom.registerCounterWithLabels)
  .mock.calls.findIndex(([opts]) => opts.name === 'upload_key_owner_total');
const ownerCounter = vi.mocked(prom.registerCounterWithLabels).mock.results[counterAt].value as {
  inc: Mock;
};

const CALLER = 7;
const OTHER = 8;
const OWN = 'aa12cd34-ef56-4a7b-8c9d-0e1f2a3b4c5d';
const ABSENT = 'bb12cd34-ef56-4a7b-8c9d-0e1f2a3b4c5d';
const OTHERS = 'cc12cd34-ef56-4a7b-8c9d-0e1f2a3b4c5d';
const BEFORE = new Date(UNRECORDED_KEYS_ACCEPTED_UNTIL.getTime() - 86_400_000);
const AFTER = new Date(UNRECORDED_KEYS_ACCEPTED_UNTIL.getTime() + 60_000);

const redis = new Map<string, string>();

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Image" ("id" serial PRIMARY KEY, "userId" integer NOT NULL, "url" text NOT NULL);
    CREATE TABLE "ShopArtworkKeyOwner" (key text PRIMARY KEY, "userId" integer NOT NULL);
    CREATE TABLE "Cosmetic" (id serial PRIMARY KEY, data jsonb);
    CREATE TABLE "CosmeticShopItem" (id serial PRIMARY KEY, "cosmeticId" integer, meta jsonb);
    CREATE TABLE "ItemDefinition" (id serial PRIMARY KEY, "imageUrl" text);
    CREATE TABLE "ImageCdnShopTakedown" (url text, "shopItemId" integer);
  `);
});

beforeEach(async () => {
  await holder.db.exec(
    `TRUNCATE "Image", "ShopArtworkKeyOwner", "ItemDefinition", "ImageCdnShopTakedown"`
  );
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

const check = (keys: string[], now = BEFORE) => clientKeysToReupload({ keys, userId: CALLER, now });

describe('clientKeysToReupload', () => {
  it("marks nothing for the caller's own recorded key", async () => {
    await recordUploadKeyOwner(OWN, CALLER);
    expect(await check([OWN])).toEqual([]);
  });

  it('marks a key with no record and no row, before the cutoff too', async () => {
    expect(await check([ABSENT], BEFORE)).toEqual([ABSENT]);
    expect(await check([ABSENT], AFTER)).toEqual([ABSENT]);
  });

  it("marks another user's key, by record or by request log, as it marks an absent one", async () => {
    await recordUploadKeyOwner(OWN, CALLER);
    await recordUploadKeyOwner(OTHERS, OTHER);
    expect(await check([OWN, OTHERS])).toEqual([OTHERS]);
    expect(await check([OWN, ABSENT])).toEqual([ABSENT]);
    redis.clear();
    holder.issued = [
      { key: OWN, userId: CALLER },
      { key: OTHERS, userId: OTHER },
    ];
    expect(await check([OWN, OTHERS])).toEqual([OTHERS]);
  });

  it('marks every key of a call over the key cap', async () => {
    await recordUploadKeyOwner(OWN, CALLER);
    const many = [
      OWN,
      ...Array.from(
        { length: MAX_KEYS },
        (_, i) => `${String(i).padStart(8, '0')}-ef56-4a7b-8c9d-0e1f2a3b4c5d`
      ),
    ];
    expect(await check(many)).toEqual(many);
  });

  it('marks a key used by shop artwork or taken down from the shop', async () => {
    await recordUploadKeyOwner(OWN, CALLER);
    await recordUploadKeyOwner(OTHERS, CALLER);
    await holder.db.exec(`INSERT INTO "ItemDefinition" ("imageUrl") VALUES ('${OWN}')`);
    await holder.db.exec(`INSERT INTO "ImageCdnShopTakedown" (url) VALUES ('${OTHERS}')`);
    expect(await check([OWN, OTHERS])).toEqual([OWN, OTHERS]);
  });

  it('marks nothing while the request log is down, even a key the issue record gives another user', async () => {
    await recordUploadKeyOwner(OTHERS, OTHER);
    holder.logDown = true;
    expect(await check([OTHERS])).toEqual([]);
  });

  it('takes the issue record over the request log for a key both hold', async () => {
    await recordUploadKeyOwner(OWN, CALLER);
    holder.issued = [{ key: OWN, userId: OTHER }];
    expect(await check([OWN])).toEqual([]);
  });

  it('marks a key sent in upper case, as sent', async () => {
    await recordUploadKeyOwner(OTHERS, CALLER);
    await holder.db.exec(`INSERT INTO "Image" ("userId", url) VALUES (${OTHER}, '${OTHERS}')`);
    expect(await check([OTHERS.toUpperCase()])).toEqual([OTHERS.toUpperCase()]);
  });

  it('rejects, rather than marks, when the row check fails', async () => {
    await recordUploadKeyOwner(OWN, CALLER);
    dbMock.dbWrite.$queryRaw.mockRejectedValueOnce(new Error('db down'));
    await expect(check([OWN])).rejects.toThrow('db down');
  });

  it("marks a key of the caller's that another user's image row already has", async () => {
    await recordUploadKeyOwner(OTHERS, CALLER);
    expect(await check([OTHERS])).toEqual([]);
    await holder.db.exec(`INSERT INTO "Image" ("userId", url) VALUES (${OTHER}, '${OTHERS}')`);
    expect(await check([OTHERS])).toEqual([OTHERS]);
  });

  it('marks only the keys that would be refused, in a mixed draft', async () => {
    await recordUploadKeyOwner(OWN, CALLER);
    await holder.db.exec(`INSERT INTO "Image" ("userId", url) VALUES (${CALLER}, '${ABSENT}')`);
    await recordUploadKeyOwner(OTHERS, OTHER);
    expect(await check([OWN, ABSENT, OTHERS])).toEqual([OTHERS]);
  });

  it('marks nothing when a lookup fails, and the save still refuses after the cutoff', async () => {
    await recordUploadKeyOwner(OTHERS, OTHER);
    await holder.db.exec(`INSERT INTO "Image" ("userId", url) VALUES (${OTHER}, '${OTHERS}')`);
    holder.logDown = true;
    expect(await check([ABSENT, OTHERS])).toEqual([]);
    holder.logDown = false;
    redisMock.sysRedis.mGet.mockRejectedValueOnce(new Error('down'));
    holder.issued = [{ key: OTHERS, userId: OTHER }];
    expect(await check([ABSENT, OTHERS])).toEqual([]);

    const refusal = await assertClientKeysIssuedToCaller({
      urls: [ABSENT],
      userId: CALLER,
      now: AFTER,
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(refusal).toBeInstanceOf(TRPCError);
    expect((refusal as TRPCError).code).toBe('BAD_REQUEST');
  });

  it('writes nothing and counts only the check', async () => {
    holder.issued = [{ key: OWN, userId: CALLER }];
    ownerCounter.inc.mockClear();
    redisMock.sysRedis.set.mockClear();

    await check([OWN, ABSENT]);

    expect(redisMock.sysRedis.set).not.toHaveBeenCalled();
    expect((await holder.db.query(`SELECT * FROM "ShopArtworkKeyOwner"`)).rows).toEqual([]);
    expect(ownerCounter.inc.mock.calls).toEqual([[{ outcome: 'draft_check' }]]);
  });
});

describe('checkBatchDraftKeysSchema', () => {
  const keys = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => `${String(i).padStart(8, '0')}-ef56-4a7b-8c9d-0e1f2a3b4c5d`
    );

  it('takes at most the key-check cap, and only upload keys', () => {
    expect(BATCH_DRAFT_KEYS_PER_CHECK).toBe(MAX_KEYS);
    expect(checkBatchDraftKeysSchema.safeParse({ keys: keys(MAX_KEYS) }).success).toBe(true);
    expect(checkBatchDraftKeysSchema.safeParse({ keys: keys(MAX_KEYS + 1) }).success).toBe(false);
    expect(checkBatchDraftKeysSchema.safeParse({ keys: ['https://x/y'] }).success).toBe(false);
  });
});
