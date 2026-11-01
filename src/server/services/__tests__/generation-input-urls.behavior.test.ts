import { randomUUID } from 'crypto';
import { PGlite } from '@electric-sql/pglite';
import { TRPCError } from '@trpc/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({
  db: null as unknown as PGlite,
  refuseExternal: false,
  clickhouseDown: false,
}));

vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: {
    GENERATION_INPUT_REFUSE_EXTERNAL_HOSTS: 'generation-input-refuse-external-hosts',
  },
  isFlipt: async (flag: string) =>
    flag === 'generation-input-refuse-external-hosts' && holder.refuseExternal,
}));

// No upload request log rows: a key with no record is answered by the issue record alone.
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: {
    $query: async () => {
      if (holder.clickhouseDown) throw new Error('clickhouse down');
      return [];
    },
  },
}));

dbMock.dbWrite.$queryRaw.mockImplementation(((
  ...a: Parameters<ReturnType<typeof pgliteRaw>['queryRaw']>
) => pgliteRaw(holder.db).queryRaw(...a)) as never);

const {
  assertGenerationInputsUsable,
  assertGenerationInputUrlsUsable,
  assertStoredImageUrlsUnblocked,
  generationInputUrlsIn,
  opaqueInputUrlsIn,
  keySetSizeBucket,
  TOO_MANY_IDS_MESSAGE,
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
  holder.refuseExternal = false;
  holder.clickhouseDown = false;
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

describe('assertGenerationInputsUsable', () => {
  const CDN = (key = KEY) =>
    `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${key}/original=true`;
  const BLOB = 'https://orchestration.civitai.com/v2/consumer/blobs/ABC123.jpeg?sig=s&exp=x';
  const OWN_KEY = '11111111-2222-4333-8444-555555555555';

  const gate = (
    urls: (string | undefined)[],
    entry: Parameters<typeof assertGenerationInputsUsable>[0]['entry'] = 'iterateGenerate'
  ) =>
    assertGenerationInputsUsable({
      urls,
      userId: CALLER,
      entry,
      isApiCaller: false,
      now: AFTER,
    }).then(
      () => 'accepted',
      (e: unknown) => {
        if (e instanceof TRPCError && e.code === 'BAD_REQUEST') {
          expect(e.message).toBe(GENERATION_IMAGE_UNAVAILABLE_MESSAGE);
          return 'refused';
        }
        throw e;
      }
    );

  it('accepts an orchestrator blob without reading the database', async () => {
    dbMock.dbWrite.$queryRaw.mockClear();
    expect(await gate([BLOB])).toBe('accepted');
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it("accepts the caller's own image and another user's public image, as a key or a CDN url", async () => {
    await givenImage();
    await givenImage({ id: 101, userId: CALLER, url: OWN_KEY, postId: null });
    expect(await gate([KEY, CDN(), OWN_KEY, CDN(OWN_KEY)])).toBe('accepted');
  });

  it.each([
    ['private', `UPDATE "Post" SET availability = 'Private'`],
    ['under review', `UPDATE "Image" SET "needsReview" = 'minor'`],
    ['blocked', `UPDATE "Image" SET "blockedFor" = 'moderated'`],
    ['marked a violation', `UPDATE "Image" SET "tosViolation" = true`],
    ['in a post marked a violation', `UPDATE "Post" SET "tosViolation" = true`],
  ])("refuses another user's image that is %s, as a key or a CDN url", async (_, sql) => {
    await givenImage();
    expect(await gate([CDN()])).toBe('accepted');
    await holder.db.exec(sql);
    expect(await gate([KEY])).toBe('refused');
    expect(await gate([CDN()])).toBe('refused');
  });

  it.each([
    ['blocked', { blockedFor: 'moderated' }],
    ['marked a violation', { tosViolation: true }],
  ])("refuses the caller's own image that is %s", async (_, over) => {
    await givenImage({ userId: CALLER, ...over });
    expect(await gate([CDN()])).toBe('refused');
  });

  it("refuses the caller's own image in a post marked a violation", async () => {
    await givenImage({ userId: CALLER });
    expect(await gate([CDN()])).toBe('accepted');
    await holder.db.exec(`UPDATE "Post" SET "tosViolation" = true`);
    expect(await gate([CDN()])).toBe('refused');
  });

  it('accepts a key issued to the caller and refuses one issued to another user', async () => {
    await recordUploadKeyOwner(OWN_KEY, CALLER);
    await recordUploadKeyOwner(KEY, OTHER);
    expect(await gate([CDN(OWN_KEY)])).toBe('accepted');
    expect(await gate([CDN(KEY)])).toBe('refused');
    expect(await gate([KEY])).toBe('refused');
  });

  it("refuses a CDN url carrying the caller's own key beside another user's private one", async () => {
    await givenImage({ postId: null });
    await givenImage({ id: 101, userId: CALLER, url: OWN_KEY, postId: null });
    const both = `https://image.civitai.com/x/${OWN_KEY}/original=true?k=${KEY}`;
    expect(await gate([both])).toBe('refused');
  });

  it.each([
    ['a CDN url with no key', 'https://image.civitai.com/x/original=true/a.png'],
    ['another civitai host', `https://civitai.com/api/redirect/${OWN_KEY}`],
    ['http', `http://image.civitai.com/x/${OWN_KEY}/original=true`],
    ['a data url', 'data:image/png;base64,AAAA'],
    ['a protocol-relative url', `//image.civitai.com/x/${OWN_KEY}`],
    [
      'an orchestrator url carrying another url',
      `https://orchestration.civitai.com/v2/consumer/blobs/x?redirect=${encodeURIComponent(CDN())}`,
    ],
    [
      'an orchestrator url carrying a twice-encoded url',
      `https://orchestration.civitai.com/v2/consumer/blobs/x?redirect=${encodeURIComponent(
        encodeURIComponent(CDN())
      )}`,
    ],
    ['a url with credentials', `https://u:p@image.civitai.com/x/${OWN_KEY}/original=true`],
    ['a url with a tab', `https://image.civitai.com/x/\t${OWN_KEY}/original=true`],
    ['a url with a backslash', `https://image.civitai.com\\x/${OWN_KEY}/original=true`],
  ])('refuses %s on every entry point', async (_, url) => {
    await givenImage({ userId: CALLER, url: OWN_KEY });
    for (const entry of [
      'generateFromGraph',
      'iterateGenerate',
      'imageUpload',
      'appBlocks',
      'appBlocksStep',
      'appBlocksPassThrough',
      'appBlocksWorkflow',
      'enhancePrompt',
      'comicPanelJob',
    ] as const)
      expect(await gate([url], entry)).toBe('refused');
  });

  it('refuses an external host on the browser paths', async () => {
    for (const entry of [
      'iterateGenerate',
      'getIterateCostEstimate',
      'imageUpload',
      'appBlocks',
      'comicPanelJob',
    ] as const)
      expect(await gate(['https://example.com/a.png'], entry)).toBe('refused');
  });

  it('accepts an orchestrator blob whose signature is percent-encoded', async () => {
    const signed =
      'https://orchestration.civitai.com/v2/consumer/blobs/ABC.jpeg?sig=a%2Bb%2Fc%3D&exp=2026-11-01T00%3A00%3A00Z';
    expect(await gate([signed])).toBe('accepted');
  });

  it('treats a fully-qualified host (trailing dot) as the host itself', async () => {
    await givenImage();
    // Classed as our CDN and key-checked: another user's public image passes...
    expect(
      await gate([`https://image.civitai.com./x/${KEY}/original=true`], 'appBlocksPassThrough')
    ).toBe('accepted');
    // ...and the same image once private is refused.
    await holder.db.exec(`UPDATE "Post" SET availability = 'Private'`);
    holder.refuseExternal = false;
    for (const entry of ['generateFromGraph', 'appBlocksPassThrough'] as const) {
      expect(await gate([`https://image.civitai.com./x/${KEY}/original=true`], entry)).toBe(
        'refused'
      );
      expect(await gate(['https://civitai.com./api/x'], entry)).toBe('refused');
    }
    // Control: the same host without the dot is just as refused, and a stranger's host is counted.
    expect(await gate([CDN()], 'appBlocksPassThrough')).toBe('refused');
    expect(await gate(['https://example.com./a.png'], 'appBlocksPassThrough')).toBe('accepted');
  });

  it('treats a host that only ends in a civitai name as external, not ours', async () => {
    expect(await gate(['https://notcivitai.com/a.png'], 'generateFromGraph')).toBe('accepted');
    expect(await gate(['https://evil.civitai.com/a.png'], 'generateFromGraph')).toBe('refused');
  });

  it('refuses an image stored under its full url, given as that url', async () => {
    await givenImage({ url: CDN() });
    expect(await gate([CDN()])).toBe('accepted');
    await holder.db.exec(`UPDATE "Image" SET "blockedFor" = 'moderated'`);
    expect(await gate([CDN()])).toBe('refused');
    await holder.db.exec(
      `UPDATE "Image" SET "blockedFor" = NULL; UPDATE "Post" SET availability = 'Private'`
    );
    expect(await gate([CDN()])).toBe('refused');
  });

  describe('an orchestrator-native input (opaqueInput)', () => {
    const opaque = (urls: string[]) =>
      assertGenerationInputsUsable({
        urls,
        userId: CALLER,
        entry: 'appBlocksPassThrough',
        isApiCaller: false,
        opaqueInput: true,
        now: AFTER,
      }).then(
        () => 'accepted',
        (e: unknown) => {
          if (e instanceof TRPCError && e.code === 'BAD_REQUEST') return 'refused';
          throw e;
        }
      );
    const SPELLINGS = [KEY, KEY.replace(/-/g, ''), `{${KEY.toUpperCase()}}`];

    it('accepts a uuid that names no image in any spelling, where a plain input refuses it', async () => {
      for (const id of SPELLINGS) expect(await opaque([id])).toBe('accepted');
      expect(await gate([KEY], 'appBlocksPassThrough')).toBe('refused');
    });

    it("refuses a uuid in any spelling that names another user's private image", async () => {
      await givenImage();
      for (const id of SPELLINGS) expect(await opaque([id])).toBe('accepted');
      await holder.db.exec(`UPDATE "Post" SET availability = 'Private'`);
      for (const id of SPELLINGS) expect(await opaque([id])).toBe('refused');
    });

    it('counts a plain link to one of our pages, and refuses one that carries a key or a url', async () => {
      holder.refuseExternal = false;
      expect(await opaque(['https://civitai.com/models/123'])).toBe('accepted');
      expect(await gate(['https://civitai.com/models/123'], 'appBlocksPassThrough')).toBe(
        'refused'
      );
      expect(await opaque([`https://civitai.com/api/redirect/${KEY}`])).toBe('refused');
      expect(
        await opaque([`https://civitai.com/r?to=${encodeURIComponent('https://example.com/a')}`])
      ).toBe('refused');
      expect(await opaque(['https://image.civitai.com/x/original=true/a.png'])).toBe('refused');
      // The external-link interstitial carries its target but never fetches it.
      const out = encodeURIComponent('https://example.com/post');
      expect(await opaque([`https://civitai.com/leaving?url=${out}`])).toBe('accepted');
      expect(await opaque([`https://civitai.com/_next/image?url=${out}`])).toBe('refused');
      // An http page link is the same link; an http link carrying a key is not.
      expect(await opaque(['http://civitai.com/models/123'])).toBe('accepted');
      expect(await opaque(['HTTP://example.com/a.png'])).toBe('accepted');
      expect(await opaque([`HTTP://civitai.com/api/redirect/${KEY}`])).toBe('refused');
      holder.refuseExternal = true;
      expect(await opaque(['https://civitai.com/models/123'])).toBe('refused');
    });

    it('refuses a url with a control byte inside, and counts the same url without it', async () => {
      holder.refuseExternal = false;
      expect(await opaque(['https://example.com/a\u0001.png'])).toBe('refused');
      expect(await opaque(['https://example.com/a.png'])).toBe('accepted');
    });

    it('reads many unrelated uuids in batches, and refuses past the bound', async () => {
      const uuids = (n: number) =>
        Array.from(
          { length: n },
          (_, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`
        );
      expect(await opaque(uuids(70))).toBe('accepted');
      expect(await opaque(uuids(1024))).toBe('accepted');
      await expect(
        assertGenerationInputsUsable({
          urls: uuids(1025),
          userId: CALLER,
          entry: 'appBlocksPassThrough',
          isApiCaller: false,
          opaqueInput: true,
          now: AFTER,
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: TOO_MANY_IDS_MESSAGE });
    });

    it('matches 1024 keys to their 1024 images in linear time', async () => {
      await holder.db.query(
        `INSERT INTO "Image" (id, "userId", url, "postId")
         SELECT 1000 + g, $1, lpad(g::text, 8, '0') || '-0000-4000-8000-000000000000', 1
         FROM generate_series(0, 1023) g`,
        [CALLER]
      );
      const keys = Array.from(
        { length: 1024 },
        (_, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`
      );
      const started = performance.now();
      expect(await opaque(keys)).toBe('accepted');
      // One pass is tens of milliseconds, keys × rows seconds: a wide bound stays clear of load.
      expect(performance.now() - started).toBeLessThan(750);
    });

    it('checks the keys in a later batch, not only the first', async () => {
      const keys = Array.from(
        { length: 70 },
        (_, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`
      );
      await recordUploadKeyOwner(keys[66], OTHER);
      expect(await opaque(keys)).toBe('refused');
      expect(await opaque(keys.filter((_, i) => i !== 66))).toBe('accepted');
    });

    it("finds another user's hidden image past the first lookup batch", async () => {
      const keys = Array.from(
        { length: 300 },
        (_, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`
      );
      await givenImage({ url: keys[200] });
      expect(await opaque(keys)).toBe('accepted');
      await holder.db.exec(`UPDATE "Post" SET availability = 'Private'`);
      expect(await opaque(keys)).toBe('refused');
    });

    it('checks every url in one call, whatever comes before it', async () => {
      holder.refuseExternal = false;
      const counted = 'https://example.com/a.png';
      const refused = `https://civitai.com/api/redirect/${KEY}`;
      expect(await opaque([counted, refused])).toBe('refused');
      expect(await opaque([refused, counted])).toBe('refused');
      expect(await opaque([counted, 'https://example.org/b.png'])).toBe('accepted');
    });

    it('counts an http url on an external host, and still refuses http to our image CDN', async () => {
      holder.refuseExternal = false;
      expect(await opaque(['http://json-schema.org/draft-07/schema#'])).toBe('accepted');
      expect(await gate(['http://json-schema.org/draft-07/schema#'], 'appBlocksPassThrough')).toBe(
        'refused'
      );
      expect(await opaque([`http://image.civitai.com/x/${KEY}/original=true`])).toBe('refused');
      holder.refuseExternal = true;
      expect(await opaque(['http://json-schema.org/draft-07/schema#'])).toBe('refused');
    });
  });

  it('allows an external host on the graph and opaque-input paths until the flag is on', async () => {
    for (const entry of [
      'generateFromGraph',
      'whatIfFromGraph',
      'appBlocksStep',
      'appBlocksPassThrough',
      'appBlocksWorkflow',
      'enhancePrompt',
    ] as const) {
      holder.refuseExternal = false;
      expect(await gate(['https://example.com/a.png'], entry)).toBe('accepted');
      holder.refuseExternal = true;
      expect(await gate(['https://example.com/a.png'], entry)).toBe('refused');
    }
  });

  it('checks the keys an allowed external url carries', async () => {
    const proxied = `https://proxy.example/?url=${encodeURIComponent(CDN())}`;
    await givenImage();
    expect(await gate([proxied], 'generateFromGraph')).toBe('accepted');
    await holder.db.exec(`UPDATE "Post" SET availability = 'Private'`);
    expect(await gate([proxied], 'generateFromGraph')).toBe('refused');
  });

  it("accepts an allowed external url whose uuid is another service's id, not an image", async () => {
    const foreign = `https://replicate.example/pbxt/${KEY}/out.png`;
    expect(await gate([foreign], 'generateFromGraph')).toBe('accepted');
    // The same unrecorded key given as an input itself is refused after the cutoff.
    expect(await gate([KEY], 'generateFromGraph')).toBe('refused');
  });

  it('refuses an allowed external url carrying a key issued to another user', async () => {
    await recordUploadKeyOwner(KEY, OTHER);
    expect(
      await gate([`https://proxy.example/?url=${encodeURIComponent(CDN())}`], 'generateFromGraph')
    ).toBe('refused');
  });

  it('treats the orchestrator region proxy as the orchestrator', async () => {
    const proxied = 'https://orchestration-proxy.civitai.com/v2/consumer/blobs/ABC.jpeg?sig=s';
    dbMock.dbWrite.$queryRaw.mockClear();
    expect(await gate([proxied], 'iterateGenerate')).toBe('accepted');
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(await gate([`${proxied}&u=${encodeURIComponent(CDN())}`], 'iterateGenerate')).toBe(
      'refused'
    );
  });

  it.each([
    [
      'a subdomain of the proxy host',
      'https://evil.orchestration-proxy.civitai.com/v2/consumer/blobs/x',
    ],
    [
      'a host that starts with it',
      'https://orchestration-proxy.civitai.com.evil.example/v2/consumer/blobs/x',
    ],
  ])('does not trust %s', async (_, url) => {
    expect(await gate([url], 'iterateGenerate')).toBe('refused');
  });

  it('refuses a key in an allowed external url when neither issue record store can be read', async () => {
    const foreign = `https://replicate.example/pbxt/${KEY}/out.png`;
    holder.clickhouseDown = true;
    expect(await gate([foreign], 'generateFromGraph')).toBe('accepted');
    redisMock.sysRedis.mGet.mockRejectedValue(new Error('redis down'));
    expect(await gate([foreign], 'generateFromGraph')).toBe('refused');
  });

  it("refuses an allowed external url carrying the caller's own blocked image key", async () => {
    const proxied = `https://proxy.example/?url=${encodeURIComponent(CDN())}`;
    await givenImage({ userId: CALLER });
    expect(await gate([proxied], 'generateFromGraph')).toBe('accepted');
    await holder.db.exec(`UPDATE "Image" SET "blockedFor" = 'moderated'`);
    expect(await gate([proxied], 'generateFromGraph')).toBe('refused');
  });

  it('refuses an allowed external url carrying a blocked image key', async () => {
    await givenImage({ blockedFor: 'moderated' });
    expect(
      await gate([`https://proxy.example/?url=${encodeURIComponent(CDN())}`], 'generateFromGraph')
    ).toBe('refused');
  });
});

describe('generationInputUrlsIn', () => {
  it('collects whole urls and keys at any depth, and not text that only contains one', () => {
    const input = {
      prompt: 'a cat, see https://example.com/cat.png for style',
      negativePrompt: 'https://example.com is not the style',
      resources: [{ air: 'urn:air:sdxl:checkpoint:civitai:1@2' }],
      images: [{ url: `https://image.civitai.com/x/${KEY}/original=true`, width: 1 }],
      controlNets: [{ image: { url: KEY } }],
      video: { url: 'https://orchestration.civitai.com/v2/consumer/blobs/v.mp4' },
      keyframes: ['data:image/png;base64,AAAA'],
      sampler: 'DPM++ 2M',
    };
    expect(generationInputUrlsIn(input).sort()).toEqual(
      [
        `https://image.civitai.com/x/${KEY}/original=true`,
        KEY,
        'https://orchestration.civitai.com/v2/consumer/blobs/v.mp4',
        'data:image/png;base64,AAAA',
      ].sort()
    );
  });

  it.each([
    ['a space in the path', `https://image.civitai.com/x/${KEY}/original=true/my pic.jpeg`],
    [
      'a no-break space in the path',
      `https://image.civitai.com/x/${KEY}/original=true/my\u00a0pic.jpeg`,
    ],
    ['no slashes after the scheme', `https:image.civitai.com/x/${KEY}/original=true`],
    ['one slash after the scheme', `https:/image.civitai.com/x/${KEY}/original=true`],
    ['a key without dashes', KEY.replace(/-/g, '')],
    ['a key in braces', `{${KEY}}`],
    ['another scheme', `s3://bucket/${KEY}.png`],
    ['a made-up scheme carrying a key', `civitai://${KEY}`],
    ['a file name', `${KEY}.jpeg`],
    ['a path', `/x/${KEY}/original=true`],
    ['no scheme', `image.civitai.com/x/${KEY}/original=true`],
    ['a zero-width space in front', `\u200bhttps://image.civitai.com/x/${KEY}/original=true`],
    ['a protocol-relative url with no key', '//evil.example/a.png'],
    ['another scheme with no key', 's3://bucket/a.png'],
    ['a file url with no slashes', 'file:/etc/x.png'],
    ['a blob url', 'blob:abc'],
    ['an ftp url', 'ftp:host/a.png'],
    ['a ws url', 'ws:host/a'],
    ['a wss url', 'wss:host/a'],
  ])('collects an image url with %s', (_, url) => {
    expect(generationInputUrlsIn({ images: [{ url }], prompt: url })).toEqual([url]);
  });

  it.each([
    'prompt',
    'negativePrompt',
    'musicDescription',
    'lyrics',
    'description',
    'title',
    'texturePrompt',
    'yue2Abc',
    'name',
    'trainedWords',
  ])('leaves the text field %s alone, as a string or a list of strings', (field) => {
    const url = `https://image.civitai.com/x/${KEY}/original=true`;
    expect(generationInputUrlsIn({ [field]: url })).toEqual([]);
    expect(generationInputUrlsIn({ [field]: ['text', url] })).toEqual([]);
  });

  it('still walks an object or a mixed list under a text field name', () => {
    expect(generationInputUrlsIn({ description: { url: KEY } })).toEqual([KEY]);
    expect(generationInputUrlsIn({ title: ['x', { url: KEY }] })).toEqual([KEY]);
  });

  it('leaves AIR urns and scheme-like setting values alone', () => {
    const input = {
      workflow: 'txt2img:draft',
      aspectRatio: '16:9',
      resources: [{ air: `urn:air:sdxl:lora:orchestrator:blob@${KEY}` }],
    };
    expect(generationInputUrlsIn(input)).toEqual([]);
  });
});

describe('opaqueInputUrlsIn', () => {
  const OKEY = 'ab12cd34-ef56-4a7b-8c9d-0e1f2a3b4c5d';
  const OCDN = `https://image.civitai.com/x/${OKEY}/original=true`;

  it('collects whole urls under any field name, free-text names included', () => {
    expect(
      opaqueInputUrlsIn({
        prompt: OCDN,
        trainedWords: [`image.civitai.com/x/${OKEY}`],
        image: { $ref: '$arguments', path: 'prompt', default: ' http://example.com/a.png\n' },
      }).urls
    ).toEqual([OCDN, `image.civitai.com/x/${OKEY}`, 'http://example.com/a.png']);
  });

  it('reads a whole url as a url parser does: tab, CR and LF inside are dropped', () => {
    expect(
      opaqueInputUrlsIn({ split: `https://image.civitai.com/x/\n${OKEY}/orig\tinal=true` }).urls
    ).toEqual([`https://image.civitai.com/x/${OKEY}/original=true`, OKEY]);
  });

  const base64 = (n: number) => 'QUJD'.repeat(Math.ceil(n / 4)).slice(0, n);
  const MiB = 1024 * 1024;

  it('reads up to 4 MiB of text, and reports more as too large instead of reading it', () => {
    const started = performance.now();
    expect(opaqueInputUrlsIn({ field: base64(4 * MiB - 5) })).toEqual({
      urls: [],
      tooDeep: false,
      tooLarge: false,
    });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1500);
    expect(opaqueInputUrlsIn({ field: base64(4 * MiB - 4) }).tooLarge).toBe(true);
    expect(opaqueInputUrlsIn({ a: base64(2.1 * MiB), b: base64(2.1 * MiB) }).tooLarge).toBe(true);
  });

  it('counts the text of a value split into lines once', () => {
    const text = `https://example.com/a\nhttps://example.com/b ${base64(3 * MiB)}`;
    expect(opaqueInputUrlsIn({ text }).tooLarge).toBe(false);
  });

  it('reads up to 262,144 lines of split text, and reports more as too large', () => {
    const lines = (n: number) => `${'x\n'.repeat(n - 1)}a:`;
    expect(opaqueInputUrlsIn({ text: lines(262_144) }).tooLarge).toBe(false);
    expect(opaqueInputUrlsIn({ text: lines(262_145) }).tooLarge).toBe(true);
  });

  it('collects more keys than a call can take as arguments', () => {
    // Keys overlap: each segment ends one key and its last 8 characters start the next.
    const segments = Array.from(
      { length: 140_000 },
      (_, i) => `-0000-4000-8000-${i.toString(16).padStart(12, '0')}`
    );
    const text = `see 00000000${segments.join('')}`;
    expect(opaqueInputUrlsIn({ text }).urls.length).toBe(140_000);
  });

  it('reports too many values as too large', () => {
    expect(opaqueInputUrlsIn({ list: new Array(1_048_577).fill(0) }).tooLarge).toBe(true);
    expect(opaqueInputUrlsIn({ list: new Array(1000).fill(0) }).tooLarge).toBe(false);
  });

  it('reads a long run of spaces in linear time', () => {
    const value = `a${' '.repeat(200_000)}b`;
    const started = performance.now();
    expect(opaqueInputUrlsIn({ value }).urls).toEqual([]);
    // Linear is milliseconds, the quadratic form seconds: a wide bound stays clear of load.
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it('trims Unicode spaces around a whole url, as a consumer would', () => {
    expect(opaqueInputUrlsIn({ u: ' https://example.com/a.png　', v: `﻿${OCDN}` }).urls).toEqual([
      'https://example.com/a.png',
      OCDN,
      OKEY,
    ]);
  });

  it('reads urls listed one per line as separate urls, and an object key as a value', () => {
    expect(
      opaqueInputUrlsIn({
        list: 'https://civitai.com/models/123\nhttps://example.com/a.png\n',
        chat: `what is in this picture?\n${OCDN}`,
        [OCDN]: 1,
      }).urls
    ).toEqual(['https://civitai.com/models/123', 'https://example.com/a.png', OCDN, OKEY, OCDN]);
  });

  it('finds a key broken across a line in text that splits into lines', () => {
    const wrapped = `https://proxy.example/?u=${OCDN.replace(
      OKEY,
      `${OKEY.slice(0, 14)}\n${OKEY.slice(14)}`
    )}\nNote: see above`;
    expect(opaqueInputUrlsIn({ wrapped }).urls).toContain(OKEY);
  });

  it('splits a url followed by prose, and rejoins a url wrapped onto a second line', () => {
    expect(opaqueInputUrlsIn({ u: 'https://example.com/a.png\nthen some words' }).urls).toEqual([
      'https://example.com/a.png',
    ]);
    expect(opaqueInputUrlsIn({ u: 'https://example.com/a\n.png' }).urls).toEqual([
      'https://example.com/a.png',
    ]);
  });

  it.each([
    [257, '257_512'],
    [512, '257_512'],
    [513, '513_1024'],
    [1024, '513_1024'],
    [1025, 'over_1024'],
  ])('reports %i image-only keys in the %s bucket', (size, bucket) => {
    expect(keySetSizeBucket(size)).toBe(bucket);
  });

  it('keeps a url with another control byte inside whole, for the gate to refuse', () => {
    expect(opaqueInputUrlsIn({ u: 'https://example.com/a\u0001.png' }).urls).toEqual([
      'https://example.com/a\u0001.png',
    ]);
    expect(opaqueInputUrlsIn({ u: 'https://example.com/a.png' }).urls).toEqual([
      'https://example.com/a.png',
    ]);
  });

  it('collects nothing from text that names no key', () => {
    expect(
      opaqueInputUrlsIn({
        messages: [{ role: 'user', content: 'Summarize https://example.com please' }],
        tools: [{ description: 'see https://civitai.com/models/1 for details' }],
        toolCalls: [{ arguments: JSON.stringify({ url: 'https://example.com/a.png' }) }],
        note: 'note: https://example.com',
        file: 'models/model.safetensors/x',
        host: 'example.com/a.png',
        cdnNoKey: 'see https://image.civitai.com/x/original=true/a.png now',
        chat: [
          '// fix this function\nfunction add(a, b) {}',
          'File: main.py\nprint(1)',
          'Data: the android from Star Trek',
          'Blob: a green slime monster',
          'https://www.youtube.com/watch?v=abc summarize',
        ],
        otherSchemes: ['file:main.py', 'data:text/plain,hello', 'blob:slime', 'ws://x.y/z'],
        model: 'urn:air:sdxl:checkpoint:civitai:1@1',
        path: 'output.images[0].url',
      }).urls
    ).toEqual([]);
  });

  it.each([
    ['a tool call id', `call_${OKEY}`],
    ['a bare uuid in upper case', OKEY.toUpperCase()],
    ['a path that is not ours', `v1.0/${OKEY}`],
    ['a CDN url in a JSON string', JSON.stringify({ image_url: OCDN })],
    ['a JSON-escaped CDN url', `{"u":"https:\\/\\/image.civitai.com\\/x\\/${OKEY}"}`],
    ['an over-escaped CDN url', `{\\"image_url\\":\\"${OCDN}\\"}`],
    ['a percent-encoded host', `x https://image%2Ecivitai%2Ecom/x/${OKEY} y`],
    ['a CDN url behind userinfo', `a https://evil.example\\@image.civitai.com/x/${OKEY} b`],
    ['a CDN url with a port', `a https://image.civitai.com:443/x/${OKEY} b`],
    ['a wrapper url in prose', `see https://wsrv.nl/?url=https://image.civitai.com/x/${OKEY}`],
    [
      'a key split by a tab',
      `see https://image.civitai.com/x/${OKEY.slice(0, 9)}\t${OKEY.slice(9)}`,
    ],
    ['a percent-encoded key', `see ${encodeURIComponent(OCDN)}`],
    ['text opening with a word and a colon', `Image: ${OCDN}`],
    ['a role prefix', `User: what is in ${OCDN}`],
    ['a uri list', `data:text/uri-list,${OCDN}`],
    ['JSON-escaped dashes', `{"u":"${OCDN.replace(/-/g, '\\u002d')}"}`],
    ['HTML entity dashes', `<img src="${OCDN.replace(/-/g, '&#45;')}">`],
    ['hex HTML entity dashes', `<img src="${OCDN.replace(/-/g, '&#x2D;')}">`],
    ['zero-padded entity dashes', `<img src="${OCDN.replace(/-/g, '&#0045;')}">`],
    ['zero-padded hex entity dashes', `<img src="${OCDN.replace(/-/g, '&#x002d;')}">`],
    // Only before a letter: `&#45` then a digit is another character to an HTML parser.
    ['an entity dash with no semicolon', `<img src="${OCDN.replace('-', '&#45')}">`],
    ['upper-case JSON-escaped dashes', `{"u":"${OCDN.replace(/-/g, '\\u002D')}"}`],
  ])('collects the key bare from %s', (_, text) => {
    expect(opaqueInputUrlsIn({ text }).urls).toEqual([OKEY]);
  });

  it.each([
    ['a decimal entity whose code point runs on into a digit', OCDN.replace('-e', '&#451')],
    ['a hex entity whose code point runs on into a hex letter', OCDN.replace('-', '&#x2d')],
    ['a hex entity whose code point runs on into a digit', OCDN.replace('-ef56', '&#x2d5678')],
  ])('reads no dash in %s', (_, url) => {
    expect(opaqueInputUrlsIn({ text: `<img src="${url}">` }).urls).toEqual([]);
  });

  it.each([
    ['a line of its own', `\n${OKEY}`],
    ['a line with a tab in it', `\n${OKEY}\tsee`],
    ['a line after a carriage return', `\r${OKEY}`],
    ['a tab', `\t${OKEY}`],
    ['a next-line character', `\u0085${OKEY}`],
  ])('collects a key from %s after an orchestrator url it would rejoin', (_, rest) => {
    const blob = 'https://orchestration.civitai.com/v2/consumer/blobs/a';
    expect(opaqueInputUrlsIn({ text: `${blob}${rest}` }).urls).toContain(OKEY);
  });

  it('reports an input nested past its bound instead of passing what it did not read', () => {
    let deep: unknown = { image: OCDN };
    for (let i = 0; i < 70; i++) deep = { a: deep };
    expect(opaqueInputUrlsIn(deep)).toEqual({ urls: [], tooDeep: true, tooLarge: false });
    let shallow: unknown = { image: OCDN };
    for (let i = 0; i < 40; i++) shallow = { a: shallow };
    expect(opaqueInputUrlsIn(shallow)).toEqual({ urls: [OCDN], tooDeep: false, tooLarge: false });
  });
});

describe('a url spelled so the input walk once missed it', () => {
  const gateGraph = (input: unknown) =>
    assertGenerationInputsUsable({
      urls: generationInputUrlsIn(input),
      userId: CALLER,
      entry: 'generateFromGraph',
      isApiCaller: false,
      now: AFTER,
    }).then(
      () => 'accepted',
      (e: unknown) => {
        // Only the gate's own refusal counts; a crash is not a refusal.
        if (
          e instanceof TRPCError &&
          e.code === 'BAD_REQUEST' &&
          e.message === GENERATION_IMAGE_UNAVAILABLE_MESSAGE
        )
          return 'refused';
        throw e;
      }
    );

  it.each([
    ['a space in the path', `https://image.civitai.com/x/${KEY}/original=true/my pic.jpeg`],
    ['no slashes after the scheme', `https:image.civitai.com/x/${KEY}/original=true`],
    ['a key without dashes', KEY.replace(/-/g, '')],
  ])("is refused for another user's private image, with %s", async (_, url) => {
    await givenImage({ postId: null });
    expect(
      await gateGraph({ images: [{ url: `https://image.civitai.com/x/${KEY}/original=true` }] })
    ).toBe('refused');
    expect(await gateGraph({ images: [{ url }] })).toBe('refused');
  });

  it("accepts the same spellings of another user's public image where they parse", async () => {
    await givenImage();
    expect(
      await gateGraph({
        images: [{ url: `https://image.civitai.com/x/${KEY}/original=true/my pic.jpeg` }],
      })
    ).toBe('accepted');
    expect(
      await gateGraph({ images: [{ url: `https:image.civitai.com/x/${KEY}/original=true` }] })
    ).toBe('accepted');
  });
});
