import { PGlite } from '@electric-sql/pglite';
import { TRPCError } from '@trpc/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

// No upload request log rows: a key with no record is answered by the issue record alone.
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { $query: async () => [] } }));

dbMock.dbWrite.$queryRaw.mockImplementation(((
  ...a: Parameters<ReturnType<typeof pgliteRaw>['queryRaw']>
) => pgliteRaw(holder.db).queryRaw(...a)) as never);

const { assertGenerationInputUrlsUsable } = await import('~/server/services/generation-input-urls');
const { recordUploadKeyOwner, UNRECORDED_KEYS_ACCEPTED_UNTIL } = await import(
  '~/server/services/image-url-ownership'
);

const CALLER = 7;
const OTHER = 8;
const KEY = 'ab12cd34-ef56-4a7b-8c9d-0e1f2a3b4c5d';
const AFTER = new Date(UNRECORDED_KEYS_ACCEPTED_UNTIL.getTime() + 60_000);

const redis = new Map<string, string>();

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Post" (id int PRIMARY KEY, "publishedAt" timestamp(3), availability text NOT NULL DEFAULT 'Public',
      "tosViolation" boolean NOT NULL DEFAULT false);
    CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int NOT NULL, url text NOT NULL, "postId" int,
      ingestion text NOT NULL DEFAULT 'Scanned', "blockedFor" text, "needsReview" text,
      "tosViolation" boolean NOT NULL DEFAULT false);
    CREATE TABLE "EvidenceHoldImage" ("imageId" int PRIMARY KEY, "userId" int NOT NULL);
    CREATE TABLE "EvidenceHeldUser" ("userId" int PRIMARY KEY);
    CREATE TABLE "CsamReport" (id int PRIMARY KEY, "userId" int, images jsonb NOT NULL DEFAULT '[]');
    CREATE TABLE "Report" (id int PRIMARY KEY, reason text NOT NULL);
    CREATE TABLE "UserReport" ("userId" int NOT NULL, "reportId" int NOT NULL);
  `);
});

beforeEach(async () => {
  await holder.db.exec(`
    TRUNCATE "Post", "Image", "EvidenceHoldImage", "EvidenceHeldUser", "CsamReport", "Report", "UserReport";
    INSERT INTO "Post" (id, "publishedAt") VALUES (1, now() - interval '1 day');
  `);
  redis.clear();
  redisMock.sysRedis.set.mockImplementation((async (key: string, value: string) => {
    redis.set(key, value);
    return 'OK';
  }) as never);
  redisMock.sysRedis.mGet.mockImplementation((async (keys: string[]) =>
    keys.map((k) => redis.get(k) ?? null)) as never);
});

/** One image on KEY: by default another user's, scanned and in a published public post. */
const givenImage = (over: Record<string, string | number | boolean | null> = {}) => {
  const row = { id: 100, userId: OTHER, url: KEY, postId: 1, ...over };
  const cols = Object.keys(row)
    .map((c) => `"${c}"`)
    .join(', ');
  return holder.db.query(
    `INSERT INTO "Image" (${cols}) VALUES (${Object.keys(row)
      .map((_, i) => `$${i + 1}`)
      .join(', ')})`,
    Object.values(row)
  );
};

const outcome = (urls: (string | undefined)[] = [KEY], now = AFTER) =>
  assertGenerationInputUrlsUsable({ urls, userId: CALLER, now }).then(
    () => 'accepted',
    (e: unknown) => {
      if (e instanceof TRPCError && e.code === 'BAD_REQUEST') return 'refused';
      throw e;
    }
  );

describe('assertGenerationInputUrlsUsable', () => {
  it("accepts another user's publicly visible image", async () => {
    await givenImage();
    expect(await outcome()).toBe('accepted');
  });

  it("accepts the caller's own image, whatever its post", async () => {
    await givenImage({ userId: CALLER, postId: null });
    expect(await outcome()).toBe('accepted');
  });

  it.each([
    ['not yet scanned', { ingestion: 'Pending' }],
    ['under review', { needsReview: 'minor' }],
    ['marked a violation', { tosViolation: true }],
    ['in no post', { postId: null }],
  ])("refuses another user's image %s", async (_, over) => {
    await givenImage(over);
    expect(await outcome()).toBe('refused');
  });

  it.each([
    ['unpublished', `UPDATE "Post" SET "publishedAt" = NULL`],
    ['scheduled', `UPDATE "Post" SET "publishedAt" = now() + interval '1 day'`],
    ['private', `UPDATE "Post" SET availability = 'Private'`],
    ['early access', `UPDATE "Post" SET availability = 'EarlyAccess'`],
    ['marked a violation', `UPDATE "Post" SET "tosViolation" = true`],
  ])("refuses another user's image in a post that is %s", async (_, sql) => {
    await givenImage();
    await holder.db.exec(sql);
    expect(await outcome()).toBe('refused');
  });

  it("accepts another user's image in an unsearchable post", async () => {
    await givenImage();
    await holder.db.exec(`UPDATE "Post" SET availability = 'Unsearchable'`);
    expect(await outcome()).toBe('accepted');
  });

  // Each would be accepted as the caller's own or as another user's public image without its mark.
  describe.each([
    ['the caller', CALLER],
    ['another user', OTHER],
  ])('refuses an image of %s', (_, owner) => {
    it('that is blocked', async () => {
      await givenImage({ userId: owner, blockedFor: 'moderated' });
      expect(await outcome()).toBe('refused');
    });

    it('that a hold kept', async () => {
      await givenImage({ userId: owner });
      await holder.db.exec(
        `INSERT INTO "EvidenceHoldImage" ("imageId", "userId") VALUES (100, ${owner})`
      );
      expect(await outcome()).toBe('refused');
    });

    it('whose owner is under a hold marker', async () => {
      await givenImage({ userId: owner });
      await holder.db.exec(`INSERT INTO "EvidenceHeldUser" ("userId") VALUES (${owner})`);
      expect(await outcome()).toBe('refused');
    });

    it('that is in a report', async () => {
      await givenImage({ userId: owner });
      await holder.db.exec(`INSERT INTO "CsamReport" (id, images) VALUES (1, '[100]')`);
      expect(await outcome()).toBe('refused');
    });
  });

  it('refuses when any one of several images on the key is blocked', async () => {
    await givenImage();
    await givenImage({ id: 101, blockedFor: 'moderated', postId: null });
    expect(await outcome()).toBe('refused');
  });

  it("refuses when any one of another user's images on the key is not public", async () => {
    await givenImage();
    await givenImage({ id: 101, postId: null });
    expect(await outcome()).toBe('refused');
  });

  it("refuses another user's image named by a full url, in any case", async () => {
    await givenImage({ postId: null });
    expect(await outcome([`https://cdn.example/x/${KEY.toUpperCase()}/original=true`])).toBe(
      'refused'
    );
  });

  describe('a key with no image', () => {
    it('is accepted when it was issued to the caller', async () => {
      await recordUploadKeyOwner(KEY, CALLER);
      expect(await outcome()).toBe('accepted');
    });

    it('is refused when it was issued to another user', async () => {
      await recordUploadKeyOwner(KEY, OTHER);
      expect(await outcome()).toBe('refused');
    });

    it('is refused with no issue record after the cutoff', async () => {
      expect(await outcome()).toBe('refused');
    });
  });

  it('accepts a public image of another user even though its key was issued to them', async () => {
    await givenImage();
    await recordUploadKeyOwner(KEY, OTHER);
    expect(await outcome()).toBe('accepted');
  });

  it('checks every url, and accepts urls with no upload key', async () => {
    await givenImage();
    const blocked = 'cd34ab12-ef56-4a7b-8c9d-0e1f2a3b4c5d';
    await givenImage({ id: 101, url: blocked, blockedFor: 'moderated' });
    expect(await outcome([undefined, 'https://example.com/a.png', KEY])).toBe('accepted');
    expect(await outcome([KEY, blocked])).toBe('refused');
  });
});
