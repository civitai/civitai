import { randomUUID } from 'crypto';
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

const {
  assertGenerationInputUrlsUsable,
  assertStoredImageUrlsUnblocked,
  GENERATION_IMAGE_UNAVAILABLE_MESSAGE,
} = await import('~/server/services/generation-input-urls');
const { MAX_KEYS, recordUploadKeyOwner, UNRECORDED_KEYS_ACCEPTED_UNTIL } = await import(
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

  // Accepted as the caller's own, or as another user's public image, without the block.
  it.each([
    ['the caller', CALLER],
    ['another user', OTHER],
  ])('refuses a blocked image of %s', async (_, owner) => {
    await givenImage({ userId: owner, blockedFor: 'moderated' });
    expect(await outcome()).toBe('refused');
  });

  // The outcome depends only on what users can see of the image, the same for every owner.
  it.each([
    ['the caller', CALLER],
    ['another user', OTHER],
  ])('decides on the image alone, not on records about %s', async (_, owner) => {
    await givenImage({ userId: owner });
    await holder.db.exec(`
      INSERT INTO "EvidenceHoldImage" ("imageId", "userId") VALUES (100, ${owner});
      INSERT INTO "EvidenceHeldUser" ("userId") VALUES (${owner});
      INSERT INTO "CsamReport" (id, "userId", images) VALUES (1, ${owner}, '[100]');
    `);
    expect(await outcome()).toBe('accepted');
  });

  it("refuses a blocked image of the caller's on a key another user's public image shares", async () => {
    await givenImage();
    await givenImage({ id: 101, userId: CALLER, blockedFor: 'moderated' });
    expect(await outcome()).toBe('refused');
  });

  it("refuses when any one of another user's images on the key is not public", async () => {
    await givenImage();
    await givenImage({ id: 101, postId: null });
    expect(await outcome()).toBe('refused');
  });

  it('accepts a key the caller has an image on, whatever other images share it', async () => {
    await givenImage({ postId: null });
    await givenImage({ id: 101, userId: CALLER, postId: null });
    expect(await outcome()).toBe('accepted');
  });

  it.each([
    ['an absolute url on another host', `https://example.com/${KEY}`],
    ['a url carrying it in a query string', `https://example.com/a.png?k=${KEY}`],
    ['a url on the image host', `https://image.example/x/${KEY}/original=true`],
    ['a relative path', `x/${KEY}`],
    ['upper case', KEY.toUpperCase()],
    ['padding', ` ${KEY}`],
  ])("refuses the caller's own key given as %s", async (_, url) => {
    await givenImage({ userId: CALLER });
    expect(await outcome([KEY])).toBe('accepted');
    expect(await outcome([url])).toBe('refused');
  });

  it('refuses with a message about the generation, not a cover image', async () => {
    await expect(
      assertGenerationInputUrlsUsable({ urls: [KEY], userId: CALLER, now: AFTER })
    ).rejects.toThrow(GENERATION_IMAGE_UNAVAILABLE_MESSAGE);
    await recordUploadKeyOwner(KEY, CALLER);
    await givenImage({ blockedFor: 'moderated' });
    await expect(
      assertGenerationInputUrlsUsable({ urls: [KEY], userId: CALLER, now: AFTER })
    ).rejects.toThrow(GENERATION_IMAGE_UNAVAILABLE_MESSAGE);
  });

  it('refuses more upload keys than one check takes', async () => {
    const many = Array.from(
      { length: MAX_KEYS + 1 },
      (_, i) => `${String(i).padStart(8, '0')}-ef56-4a7b-8c9d-0e1f2a3b4c5d`
    );
    // The caller's own images, so no key reaches the issue-record check and its own limit.
    for (const [i, key] of many.entries())
      await givenImage({ id: 200 + i, url: key, userId: CALLER });
    expect(await outcome(many.slice(0, MAX_KEYS))).toBe('accepted');
    expect(await outcome(many)).toBe('refused');
  });

  it('accepts a key as the upload routes mint it', async () => {
    const minted = randomUUID();
    await recordUploadKeyOwner(minted, CALLER);
    expect(await outcome([minted])).toBe('accepted');
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

  it('passes on a failure that is not a refusal', async () => {
    const failure = new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'down' });
    const query = dbMock.dbWrite.$queryRaw;
    const real = query.getMockImplementation()!;
    // The image lookup runs; the issue check's own lookup fails.
    query.mockImplementationOnce(real).mockRejectedValueOnce(failure);
    try {
      await expect(
        assertGenerationInputUrlsUsable({ urls: [KEY], userId: CALLER, now: AFTER })
      ).rejects.toBe(failure);
    } finally {
      query.mockReset();
      query.mockImplementation(real);
    }
  });

  it('checks every url, and refuses a url with no upload key', async () => {
    await givenImage();
    const blocked = 'cd34ab12-ef56-4a7b-8c9d-0e1f2a3b4c5d';
    await givenImage({ id: 101, url: blocked, blockedFor: 'moderated' });
    expect(await outcome([undefined, KEY])).toBe('accepted');
    expect(await outcome([KEY, blocked])).toBe('refused');
    expect(await outcome([KEY, 'https://example.com/a.png'])).toBe('refused');
  });
});

describe('assertStoredImageUrlsUnblocked', () => {
  const stored = (urls: string[]) =>
    assertStoredImageUrlsUnblocked(urls).then(
      () => 'accepted',
      (e: unknown) =>
        e instanceof TRPCError && e.code === 'BAD_REQUEST' ? 'refused' : Promise.reject(e)
    );

  it('refuses a stored url whose image is blocked, whoever owns it, and passes it otherwise', async () => {
    await givenImage({ userId: CALLER, postId: null });
    expect(await stored([KEY])).toBe('accepted');
    await holder.db.exec(`UPDATE "Image" SET "blockedFor" = 'moderated'`);
    expect(await stored([KEY])).toBe('refused');
    expect(await stored([`https://cdn.example/x/${KEY.toUpperCase()}/original=true`])).toBe(
      'refused'
    );
    await expect(assertStoredImageUrlsUnblocked([KEY])).rejects.toThrow(
      GENERATION_IMAGE_UNAVAILABLE_MESSAGE
    );
  });

  it('matches an image stored under the full url', async () => {
    const url = `https://cdn.example/x/${KEY}/original=true`;
    await givenImage({ url, blockedFor: 'moderated' });
    expect(await stored([url])).toBe('refused');
  });
});
