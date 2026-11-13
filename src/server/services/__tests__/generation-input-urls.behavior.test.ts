import { randomUUID } from 'crypto';
import { PGlite } from '@electric-sql/pglite';
import { TRPCError } from '@trpc/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as ImageUrlOwnership from '~/server/services/image-url-ownership';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({
  db: null as unknown as PGlite,
  refuseExternal: false,
  scannedRows: false,
  refuseExternalApp: true,
  clickhouseDown: false,
}));

vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: {
    GENERATION_INPUT_REFUSE_EXTERNAL_HOSTS: 'generation-input-refuse-external-hosts',
    APP_BLOCK_SOURCE_SCANNED_ROWS: 'app-block-source-scanned-rows',
    APP_BLOCK_REFUSE_EXTERNAL_SOURCES: 'app-block-refuse-external-sources',
  },
  isFlipt: async (flag: string) =>
    (flag === 'generation-input-refuse-external-hosts' && holder.refuseExternal) ||
    (flag === 'app-block-source-scanned-rows' && holder.scannedRows) ||
    (flag === 'app-block-refuse-external-sources' && holder.refuseExternalApp),
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

// Counts the gate's `keysIn` calls, so a match's cost is asserted as work, not wall clock.
const keysInCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('~/server/services/image-url-ownership', async (importOriginal) => {
  const actual = await importOriginal<typeof ImageUrlOwnership>();
  return {
    ...actual,
    keysIn: (url: string | null | undefined) => {
      keysInCalls.count++;
      return actual.keysIn(url);
    },
  };
});

const {
  assertGenerationInputsUsable,
  countAppBlockHostSources,
  assertGenerationInputUrlsUsable,
  assertStoredImageUrlsUnblocked,
  generationInputUrlsIn,
  opaqueInputUrlsIn,
  keySetSizeBucket,
  TOO_MANY_IDS_MESSAGE,
  GENERATION_IMAGE_UNAVAILABLE_MESSAGE,
  APP_SOURCE_PENDING_MESSAGE,
  APP_SOURCE_UNUSABLE_MESSAGE,
  APP_SOURCE_NOT_ON_CIVITAI_MESSAGE,
} = await import('~/server/services/generation-input-urls');
const { registerCounterWithLabels } = await import('~/server/prom/client');
const { __resetRecentExternalHostUsersForTest } = await import(
  '~/server/services/generation-input-hosts'
);
const { MAX_KEYS, recordUploadKeyOwner, UNRECORDED_KEYS_ACCEPTED_UNTIL } = await import(
  '~/server/services/image-url-ownership'
);
const { getStep } = await import('~/server/services/blocks/steps');

/** The external-host refusal, pinned as the literal a caller reads. */
const EXTERNAL_MESSAGE =
  'This request includes a link to an image hosted outside Civitai. Please upload the image instead.';
/** The refusal of a plain Civitai page link where it is not free text. */
const PAGE_LINK_MESSAGE =
  'This request includes a link to a Civitai page, not an image. Please upload the image instead.';

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
      "tosViolation" boolean NOT NULL DEFAULT false, minor boolean NOT NULL DEFAULT false,
      poi boolean NOT NULL DEFAULT false);
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
  holder.scannedRows = false;
  holder.refuseExternalApp = true;
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

describe('an App Blocks generation source', () => {
  const CDN = (key = KEY) =>
    `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${key}/original=true`;
  const BLOB = 'https://orchestration.civitai.com/v2/consumer/blobs/ABC123.jpeg?sig=s&exp=x';
  const APP_ENTRIES = [
    'appBlocks',
    'appBlocksStep',
    'appBlocksPassThrough',
    'appBlocksWorkflow',
  ] as const;
  const check = (
    urls: string[],
    entry: Parameters<typeof assertGenerationInputsUsable>[0]['entry'],
    opaqueInput = false
  ) =>
    assertGenerationInputsUsable({
      urls,
      userId: CALLER,
      entry,
      isApiCaller: false,
      opaqueInput,
      now: AFTER,
    }).then(
      () => 'accepted',
      (e: unknown) => {
        if (e instanceof TRPCError && e.code === 'BAD_REQUEST') return `refused: ${e.message}`;
        throw e;
      }
    );

  it.each([
    ['flagged minor', { minor: true }, APP_SOURCE_UNUSABLE_MESSAGE],
    ['flagged poi', { poi: true }, APP_SOURCE_UNUSABLE_MESSAGE],
    ['still scanning', { ingestion: 'Pending' }, APP_SOURCE_PENDING_MESSAGE],
    ['held for review', { needsReview: 'poi' }, APP_SOURCE_UNUSABLE_MESSAGE],
  ])("refuses the caller's own image that is %s", async (_, over, message) => {
    await givenImage({ userId: CALLER, postId: null });
    for (const entry of APP_ENTRIES) expect(await check([CDN()], entry)).toBe('accepted');
    await holder.db.query(`DELETE FROM "Image"`);
    await givenImage({ userId: CALLER, postId: null, ...over });
    for (const entry of APP_ENTRIES)
      expect(await check([CDN()], entry)).toBe(`refused: ${message}`);
  });

  it.each([
    ['flagged minor', { minor: true }],
    ['still scanning', { ingestion: 'Pending' }],
  ])("refuses another user's public image that is %s, without saying why", async (_, over) => {
    await givenImage(over);
    expect(await check([CDN()], 'appBlocksPassThrough')).toBe(
      `refused: ${GENERATION_IMAGE_UNAVAILABLE_MESSAGE}`
    );
  });

  it('refuses an upload key issued to the caller that has no image row yet', async () => {
    const own = '11111111-2222-4333-8444-555555555555';
    await recordUploadKeyOwner(own, CALLER);
    expect(await check([CDN(own)], 'generateFromGraph')).toBe('accepted');
    expect(await check([CDN(own)], 'appBlocksPassThrough')).toBe(
      `refused: ${APP_SOURCE_UNUSABLE_MESSAGE}`
    );
    expect(await check([own], 'appBlocksPassThrough', true)).toBe(
      `refused: ${APP_SOURCE_UNUSABLE_MESSAGE}`
    );
  });

  it('control: an opaque uuid that names no upload at all still passes', async () => {
    expect(await check([KEY], 'appBlocksPassThrough', true)).toBe('accepted');
  });

  it('refuses an external host whatever the external-host flag says', async () => {
    holder.refuseExternal = false;
    for (const entry of APP_ENTRIES)
      expect(await check(['https://example.com/a.png'], entry)).toBe(
        `refused: ${EXTERNAL_MESSAGE}`
      );
    expect(await check(['https://example.com/a.png'], 'generateFromGraph')).toBe('accepted');
  });

  it('while external refusal is off, allows an external host from an app and logs it without the url', async () => {
    holder.refuseExternalApp = false;
    loggingMock.logToAxiom.mockClear();
    const url = 'https://example.com/secret-path/a.png';
    await expect(
      assertGenerationInputsUsable({
        urls: [url],
        userId: CALLER,
        entry: 'appBlocksPassThrough',
        isApiCaller: false,
        now: AFTER,
        appBlockLog: { appBlockId: 'apb_1', stepTypes: 'videogen' },
      })
    ).resolves.toBeUndefined();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app-block-source-refusal',
        reason: 'external',
        mode: 'log',
        appBlockId: 'apb_1',
        stepTypes: 'videogen',
        entry: 'appBlocksPassThrough',
      })
    );
    expect(JSON.stringify(loggingMock.logToAxiom.mock.calls)).not.toContain('secret-path');
  });

  it.each(['Rescan', 'PendingManualAssignment'])(
    "refuses the caller's own image in %s as still being scanned",
    async (ingestion) => {
      await givenImage({ userId: CALLER, postId: null, ingestion });
      expect(await check([CDN()], 'appBlocksPassThrough')).toBe(
        `refused: ${APP_SOURCE_PENDING_MESSAGE}`
      );
    }
  );

  it.each(['NotFound', 'Error'])(
    "refuses the caller's own image in %s as unusable, not as pending",
    async (ingestion) => {
      await givenImage({ userId: CALLER, postId: null, ingestion });
      expect(await check([CDN()], 'appBlocksPassThrough')).toBe(
        `refused: ${APP_SOURCE_UNUSABLE_MESSAGE}`
      );
    }
  );

  it('with app external refusal off: the txt2img arm still refuses, the step arms log, the general flag still refuses', async () => {
    holder.refuseExternalApp = false;
    const url = 'https://example.com/a.png';
    expect(await check([url], 'appBlocks')).toBe(`refused: ${EXTERNAL_MESSAGE}`);
    expect(await check([url], 'appBlocksPassThrough')).toBe('accepted');
    holder.refuseExternal = true;
    expect(await check([url], 'appBlocksPassThrough')).toBe(`refused: ${EXTERNAL_MESSAGE}`);
  });

  it.each([
    ['held', { needsReview: 'poi' }],
    ['unscannable', { ingestion: 'NotFound' }],
    ['pending', { ingestion: 'Pending' }],
  ])('logs a %s refusal of an own image once, without naming the image', async (reason, over) => {
    await givenImage({ userId: CALLER, postId: null, ...over });
    loggingMock.logToAxiom.mockClear();
    expect(await check([CDN()], 'appBlocksPassThrough')).toMatch(/^refused: /);
    expect(loggingMock.logToAxiom).toHaveBeenCalledTimes(1);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'app-block-source-refusal', reason })
    );
    const logged = JSON.stringify(loggingMock.logToAxiom.mock.calls).toLowerCase();
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain(KEY.replace(/-/g, ''));
  });

  describe('an inline customComfy graph (appBlocksInlineComfy)', () => {
    const OWN = '11111111-2222-4333-8444-555555555555';
    const unusable = `refused: ${APP_SOURCE_UNUSABLE_MESSAGE}`;
    const logged = (reason: string) =>
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'app-block-source-refusal', reason })
      );

    it.each([
      ['held', { needsReview: 'poi' }],
      ['unscannable', { ingestion: 'NotFound' }],
    ])('refuses an own %s image and logs the reason', async (reason, over) => {
      await givenImage({ userId: CALLER, postId: null, ...over });
      loggingMock.logToAxiom.mockClear();
      expect(await check([CDN()], 'appBlocksInlineComfy', true)).toBe(unusable);
      logged(reason);
    });

    it('returns pending for an own image still being scanned', async () => {
      await givenImage({ userId: CALLER, postId: null, ingestion: 'Pending' });
      loggingMock.logToAxiom.mockClear();
      const got = await check([CDN()], 'appBlocksInlineComfy', true);
      expect(got).toMatch(/^refused: /);
      expect(got).not.toBe(unusable);
      logged('pending');
    });

    it('refuses an own upload with no image row', async () => {
      await recordUploadKeyOwner(OWN, CALLER);
      loggingMock.logToAxiom.mockClear();
      expect(await check([OWN], 'appBlocksInlineComfy', true)).toBe(unusable);
      logged('unrowed');
    });

    it('refuses a row-less key while an issue store is unreadable', async () => {
      await recordUploadKeyOwner(OWN, CALLER);
      redisMock.sysRedis.mGet.mockRejectedValueOnce(new Error('redis down'));
      loggingMock.logToAxiom.mockClear();
      expect(await check([OWN], 'appBlocksInlineComfy', true)).toBe(unusable);
      logged('store-unreadable');
    });
  });

  it('logs an unrowed upload refusal', async () => {
    const own = '11111111-2222-4333-8444-555555555555';
    await recordUploadKeyOwner(own, CALLER);
    loggingMock.logToAxiom.mockClear();
    expect(await check([CDN(own)], 'appBlocksPassThrough')).toBe(
      `refused: ${APP_SOURCE_UNUSABLE_MESSAGE}`
    );
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'unrowed' })
    );
    const logged = JSON.stringify(loggingMock.logToAxiom.mock.calls).toLowerCase();
    expect(logged).not.toContain(own);
    expect(logged).not.toContain(own.replace(/-/g, ''));
  });

  it('refuses a row-less key from an app while either issue store is unreadable, and logs it', async () => {
    const own = '11111111-2222-4333-8444-555555555555';
    await recordUploadKeyOwner(own, CALLER);
    const unusable = `refused: ${APP_SOURCE_UNUSABLE_MESSAGE}`;

    redisMock.sysRedis.mGet.mockRejectedValueOnce(new Error('redis down'));
    loggingMock.logToAxiom.mockClear();
    expect(await check([own], 'appBlocksPassThrough', true)).toBe(unusable);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'app-block-source-refusal', reason: 'store-unreadable' })
    );
    const logged = JSON.stringify(loggingMock.logToAxiom.mock.calls).toLowerCase();
    expect(logged).not.toContain(own);
    expect(logged).not.toContain(own.replace(/-/g, ''));

    redisMock.sysRedis.mGet.mockRejectedValueOnce(new Error('redis down'));
    expect(await check([CDN(own)], 'appBlocksPassThrough')).toMatch(/^refused: /);

    holder.clickhouseDown = true;
    expect(await check([KEY], 'appBlocksPassThrough', true)).toBe(unusable);
    // Off the app paths one unreadable store still is not enough to refuse.
    expect(await check([KEY], 'generateFromGraph', true)).toBe('accepted');
  });

  it('logs an external url refusal with mode refuse when the app refusal is on', async () => {
    loggingMock.logToAxiom.mockClear();
    await check(['https://example.com/a.png'], 'appBlocksPassThrough');
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'external', mode: 'refuse' })
    );
  });

  it('logs external urls once per host bucket in one call', async () => {
    holder.refuseExternalApp = false;
    loggingMock.logToAxiom.mockClear();
    await check(['https://example.com/a.png', 'https://example.com/b.png'], 'appBlocksPassThrough');
    expect(
      loggingMock.logToAxiom.mock.calls.filter(
        ([d]) => (d as { reason?: string }).reason === 'external'
      )
    ).toHaveLength(1);
  });

  it('refuses a key with one clean row and one held or pending row beside it', async () => {
    await givenImage({ userId: CALLER, postId: null });
    await givenImage({ id: 101, userId: CALLER, postId: null, ingestion: 'Pending' });
    expect(await check([CDN()], 'appBlocksPassThrough')).toBe(
      `refused: ${APP_SOURCE_PENDING_MESSAGE}`
    );
  });

  it('a row both held and still scanning is refused as unusable, not as pending', async () => {
    await givenImage({ userId: CALLER, postId: null, ingestion: 'Pending', needsReview: 'poi' });
    expect(await check([CDN()], 'appBlocksPassThrough')).toBe(
      `refused: ${APP_SOURCE_UNUSABLE_MESSAGE}`
    );
  });

  it('refuses an orchestrator blob once scanned source rows are on, and only from an app', async () => {
    for (const entry of APP_ENTRIES) expect(await check([BLOB], entry)).toBe('accepted');
    holder.scannedRows = true;
    for (const entry of APP_ENTRIES)
      expect(await check([BLOB], entry)).toBe(`refused: ${APP_SOURCE_NOT_ON_CIVITAI_MESSAGE}`);
    expect(await check([BLOB], 'generateFromGraph')).toBe('accepted');
  });

  describe('the orchestrator source count', () => {
    const JOB_OUTPUT = 'https://orchestration.civitai.com/v2/consumer/jobs/J1/outputs/out.png';
    const hostRows = () =>
      loggingMock.logToAxiom.mock.calls
        .map(([data]) => data as Record<string, unknown>)
        .filter((data) => data.name === 'app-block-host-source');
    // `appBlocks` gates inside its step builder; its router counts with countAppBlockHostSources.
    const GATE_COUNTED = APP_ENTRIES.filter((entry) => entry !== 'appBlocks');

    // The setup mock's stub for the counter, found by name; captured at collection time.
    const registered = vi.mocked(registerCounterWithLabels).mock;
    const hostSourceCounter = registered.results[
      registered.calls.findIndex(([def]) => def.name === 'app_block_host_source_total')
    ]?.value as { inc: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      loggingMock.logToAxiom.mockClear();
      hostSourceCounter.inc.mockClear();
    });

    it('counts a consumer blob and any other orchestrator path, refusing neither', async () => {
      for (const entry of GATE_COUNTED) {
        loggingMock.logToAxiom.mockClear();
        hostSourceCounter.inc.mockClear();
        expect(await check([BLOB, JOB_OUTPUT], entry)).toBe('accepted');
        expect(hostSourceCounter.inc.mock.calls).toEqual([
          [{ entry, reason: 'host-orchestrator-source' }],
          [{ entry, reason: 'host-unparsable' }],
        ]);
        expect(hostRows()).toEqual([
          expect.objectContaining({ entry, reason: 'host-orchestrator-source', count: 1 }),
          expect.objectContaining({ entry, reason: 'host-unparsable', count: 1 }),
        ]);
      }
      const logged = JSON.stringify(loggingMock.logToAxiom.mock.calls);
      expect(logged).not.toContain('ABC123');
      expect(logged).not.toContain('orchestration.civitai.com');
    });

    it('writes one row per reason with its count', async () => {
      const other = 'https://orchestration.civitai.com/v2/consumer/blobs/DEF456.png';
      expect(await check([BLOB, other], 'appBlocksPassThrough')).toBe('accepted');
      expect(hostSourceCounter.inc).toHaveBeenCalledTimes(2);
      expect(hostRows()).toEqual([
        expect.objectContaining({ reason: 'host-orchestrator-source', count: 2 }),
      ]);
    });

    it('a call refused for another source counts nothing', async () => {
      await givenImage({ userId: CALLER + 1, postId: null });
      expect(await check([BLOB, CDN()], 'appBlocksPassThrough')).toMatch(/^refused/);
      expect(hostRows()).toEqual([]);
      expect(hostSourceCounter.inc).not.toHaveBeenCalled();
    });

    it('control: a Civitai image, an orchestrator blob outside App Blocks, or the step builder gate, is not counted', async () => {
      await givenImage({ userId: CALLER, postId: null });
      expect(await check([CDN()], 'appBlocksPassThrough')).toBe('accepted');
      expect(await check([BLOB], 'generateFromGraph')).toBe('accepted');
      expect(await check([BLOB], 'appBlocks')).toBe('accepted');
      expect(hostRows()).toEqual([]);
      expect(hostSourceCounter.inc).not.toHaveBeenCalled();
    });

    it('tags each count with the app and with estimate or submit', async () => {
      for (const phase of ['estimate', 'submit'] as const)
        await assertGenerationInputsUsable({
          urls: [BLOB],
          userId: CALLER,
          entry: 'appBlocksPassThrough',
          isApiCaller: false,
          appBlockLog: { appBlockId: 'apb_1', stepTypes: 'videoGen', phase },
          now: AFTER,
        });
      expect(hostRows()).toEqual([
        expect.objectContaining({ appBlockId: 'apb_1', stepTypes: 'videoGen', phase: 'estimate' }),
        expect.objectContaining({ appBlockId: 'apb_1', stepTypes: 'videoGen', phase: 'submit' }),
      ]);
    });

    it('countAppBlockHostSources counts only orchestrator urls, under appBlocks, with the app', async () => {
      await countAppBlockHostSources({
        urls: [BLOB, JOB_OUTPUT, CDN(), undefined],
        appBlockLog: { appBlockId: 'apb_1', stepTypes: 'textToImage', phase: 'submit' },
      });
      expect(hostSourceCounter.inc.mock.calls).toEqual([
        [{ entry: 'appBlocks', reason: 'host-orchestrator-source' }],
        [{ entry: 'appBlocks', reason: 'host-unparsable' }],
      ]);
      expect(hostRows()).toEqual([
        expect.objectContaining({ entry: 'appBlocks', appBlockId: 'apb_1', phase: 'submit' }),
        expect.objectContaining({ entry: 'appBlocks', reason: 'host-unparsable' }),
      ]);
      holder.scannedRows = true;
      hostSourceCounter.inc.mockClear();
      await countAppBlockHostSources({ urls: [BLOB], appBlockLog: {} });
      expect(hostSourceCounter.inc).not.toHaveBeenCalled();
    });

    it('a blob the scanned-rows flag refuses is not counted', async () => {
      holder.scannedRows = true;
      expect(await check([BLOB], 'appBlocksPassThrough')).toBe(
        `refused: ${APP_SOURCE_NOT_ON_CIVITAI_MESSAGE}`
      );
      expect(hostRows()).toEqual([]);
      expect(hostSourceCounter.inc).not.toHaveBeenCalled();
    });
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

  it('reads a later url with a percent escape like the first', async () => {
    await givenImage({ userId: CALLER, postId: null });
    await holder.db.exec(`UPDATE "Image" SET "blockedFor" = 'moderated'`);
    const escaped = `https://cdn.example/x/${KEY.replace('-', '%2d')}/a%20b.jpeg`;
    expect(await stored(['https://example.com/a.png', escaped])).toBe('refused');
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
    entry: Parameters<typeof assertGenerationInputsUsable>[0]['entry'] = 'iterateGenerate',
    message = GENERATION_IMAGE_UNAVAILABLE_MESSAGE
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
          expect(e.message).toBe(message);
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
      expect(await gate(['https://example.com/a.png'], entry, EXTERNAL_MESSAGE)).toBe('refused');
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
    expect(await gate(['https://example.com./a.png'], 'generateFromGraph')).toBe('accepted');
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

    it('refuses an external url and a plain link to one of our pages from an app, whatever the flag', async () => {
      holder.refuseExternal = false;
      expect(await opaque(['https://civitai.com/models/123'])).toBe('refused');
      expect(
        await opaque([
          `https://civitai.com/leaving?url=${encodeURIComponent('https://example.com/post')}`,
        ])
      ).toBe('refused');
      expect(await opaque(['http://civitai.com/models/123'])).toBe('refused');
      expect(await opaque(['HTTP://example.com/a.png'])).toBe('refused');
      expect(await opaque([`https://civitai.com/api/redirect/${KEY}`])).toBe('refused');
    });

    describe('with app external refusal off', () => {
      const out = (url: string) => encodeURIComponent(url);
      beforeEach(async () => {
        holder.refuseExternal = false;
        holder.refuseExternalApp = false;
        await givenImage({ postId: null });
      });

      it.each([
        [`https://civitai.com/api/redirect/${KEY}`],
        [`HTTP://civitai.com/api/redirect/${KEY}`],
        [`https://civitai.com/r?to=${out(`https://example.com/${KEY}.png`)}`],
        [`https://civitai.com/_next/image?url=${out(`https://example.com/${KEY}.png`)}`],
        [`https://proxy.example/fetch?u=${out(`https://example.com/${KEY}.png`)}`],
      ])("refuses %s, which carries another user's private image key", async (url) => {
        expect(await opaque([url])).toBe('refused');
      });

      it.each([
        ['https://civitai.com/models/123'],
        ['http://civitai.com/models/123'],
        [`https://civitai.com/leaving?url=${out('https://example.com/post')}`],
        ['https://proxy.example/fetch?u=https%3A%2F%2Fexample.com%2Fa.png'],
      ])('counts %s, which carries no key, and lets it through', async (url) => {
        expect(await opaque([url])).toBe('accepted');
      });

      it('refuses our image optimizer url even without a key: it fetches its target', async () => {
        expect(
          await opaque([`https://civitai.com/_next/image?url=${out('https://example.com/a.png')}`])
        ).toBe('refused');
      });

      it('checks every url in one call, whatever comes before it', async () => {
        const counted = 'https://example.com/a.png';
        const refused = `https://civitai.com/api/redirect/${KEY}`;
        expect(await opaque([counted, refused])).toBe('refused');
        expect(await opaque([refused, counted])).toBe('refused');
        expect(await opaque([counted, 'https://example.org/b.png'])).toBe('accepted');
      });
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

    it('matches 1024 keys to their 1024 images reading each image once', async () => {
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
      keysInCalls.count = 0;
      expect(await opaque(keys)).toBe('accepted');
      // A pass over the rows is about a thousand reads; keys × rows is about a million.
      expect(keysInCalls.count).toBeGreaterThanOrEqual(1024);
      expect(keysInCalls.count).toBeLessThan(4 * 1024);
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

    it('refuses an http url on an external host from an app, and http to our image CDN', async () => {
      holder.refuseExternal = false;
      expect(await opaque(['http://json-schema.org/draft-07/schema#'])).toBe('refused');
      expect(await opaque([`http://image.civitai.com/x/${KEY}/original=true`])).toBe('refused');
    });
  });

  it('refuses an external host with its own message, and anything else with the unavailable one', async () => {
    const message = (urls: string[], entry: 'iterateGenerate' | 'appBlocksPassThrough') =>
      assertGenerationInputsUsable({ urls, userId: CALLER, entry, isApiCaller: false, now: AFTER })
        .then(() => 'accepted')
        .catch((e: TRPCError) => `${e.code}: ${e.message}`);
    holder.refuseExternal = true;
    for (const entry of ['iterateGenerate', 'appBlocksPassThrough'] as const) {
      expect(await message(['https://example.com/a.png'], entry)).toBe(
        `BAD_REQUEST: ${EXTERNAL_MESSAGE}`
      );
      expect(await message(['https://image.civitai.com/x/original=true/a.png'], entry)).toBe(
        `BAD_REQUEST: ${GENERATION_IMAGE_UNAVAILABLE_MESSAGE}`
      );
    }
  });

  it('allows an external host on the graph paths until the flag is on', async () => {
    for (const entry of ['generateFromGraph', 'whatIfFromGraph', 'enhancePrompt'] as const) {
      holder.refuseExternal = false;
      expect(await gate(['https://example.com/a.png'], entry)).toBe('accepted');
      holder.refuseExternal = true;
      expect(await gate(['https://example.com/a.png'], entry, EXTERNAL_MESSAGE)).toBe('refused');
    }
  });

  describe('the refusal count for an external url', () => {
    // The setup mock's stub for the counter, found by name; captured at collection time.
    const registered = vi.mocked(registerCounterWithLabels).mock;
    const refusalCounter = registered.results[
      registered.calls.findIndex(([def]) => def.name === 'generation_input_url_refusals_total')
    ]?.value as { inc: ReturnType<typeof vi.fn> };
    beforeEach(() => {
      __resetRecentExternalHostUsersForTest();
      refusalCounter.inc.mockClear();
    });

    it('counts it once in log mode while the flag is off, and in refuse mode once it is on', async () => {
      expect(await gate(['https://example.com/a.png'], 'generateFromGraph')).toBe('accepted');
      expect(refusalCounter.inc).toHaveBeenCalledExactlyOnceWith({
        entry: 'generateFromGraph',
        class: 'external',
        caller: 'session',
        mode: 'log',
      });

      refusalCounter.inc.mockClear();
      holder.refuseExternal = true;
      expect(await gate(['https://example.com/a.png'], 'generateFromGraph', EXTERNAL_MESSAGE)).toBe(
        'refused'
      );
      expect(refusalCounter.inc).toHaveBeenCalledExactlyOnceWith({
        entry: 'generateFromGraph',
        class: 'external',
        caller: 'session',
        mode: 'refuse',
      });
    });
  });

  describe('the external host count', () => {
    // The setup mock's stub for the counter, found by name; captured at collection time.
    const registered = vi.mocked(registerCounterWithLabels).mock;
    const hostCounter = registered.results[
      registered.calls.findIndex(([def]) => def.name === 'generation_input_external_hosts_total')
    ]?.value as { inc: ReturnType<typeof vi.fn> };
    beforeEach(() => {
      __resetRecentExternalHostUsersForTest();
      hostCounter.inc.mockClear();
      redisMock.sysRedis.pfAdd.mockClear();
    });

    it('counts an external url by host bucket and mode, and adds the caller to its day set', async () => {
      expect(await gate(['https://i.imgur.com/a.png'], 'generateFromGraph')).toBe('accepted');
      expect(hostCounter.inc).toHaveBeenCalledExactlyOnceWith({
        entry: 'generateFromGraph',
        caller: 'session',
        mode: 'log',
        host: 'imgur',
      });
      expect(redisMock.sysRedis.pfAdd).toHaveBeenCalledExactlyOnceWith(
        expect.stringMatching(
          /^system:generation-input-external-host-users:\d{4}-\d{2}-\d{2}:session:imgur$/
        ),
        String(CALLER)
      );

      hostCounter.inc.mockClear();
      holder.refuseExternal = true;
      expect(await gate(['https://i.imgur.com/a.png'], 'generateFromGraph', EXTERNAL_MESSAGE)).toBe(
        'refused'
      );
      expect(hostCounter.inc).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ mode: 'refuse', host: 'imgur' })
      );
    });

    it('is not counted where an external host is refused outright', async () => {
      expect(await gate(['https://i.imgur.com/a.png'], 'iterateGenerate', EXTERNAL_MESSAGE)).toBe(
        'refused'
      );
      expect(hostCounter.inc).not.toHaveBeenCalled();
      expect(redisMock.sysRedis.pfAdd).not.toHaveBeenCalled();
    });

    it('counts every external url in a request and adds the caller once per bucket', async () => {
      const urls = [
        'https://i.imgur.com/a.png',
        'https://i.imgur.com/b.png',
        'https://example.com/c.png',
      ];
      expect(await gate(urls, 'generateFromGraph')).toBe('accepted');
      expect(hostCounter.inc).toHaveBeenCalledTimes(3);
      expect(redisMock.sysRedis.pfAdd.mock.calls.map(([key]) => key.split(':').pop())).toEqual([
        'imgur',
        'other',
      ]);
    });

    it('counts an external url in a request a later url gets refused', async () => {
      expect(await gate(['https://i.imgur.com/a.png', CDN('no-key')], 'generateFromGraph')).toBe(
        'refused'
      );
      expect(hostCounter.inc).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ mode: 'log', host: 'imgur' })
      );
      expect(redisMock.sysRedis.pfAdd).toHaveBeenCalledTimes(1);
    });

    it('labels an API caller as api, in the count and the day set', async () => {
      await assertGenerationInputsUsable({
        urls: ['https://i.imgur.com/a.png'],
        userId: CALLER,
        entry: 'generateFromGraph',
        isApiCaller: true,
        now: AFTER,
      });
      expect(hostCounter.inc).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ caller: 'api', host: 'imgur' })
      );
      expect(redisMock.sysRedis.pfAdd).toHaveBeenCalledExactlyOnceWith(
        `system:generation-input-external-host-users:${new Date()
          .toISOString()
          .slice(0, 10)}:api:imgur`,
        String(CALLER)
      );
    });
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
      GENERATION_IMAGE_UNAVAILABLE_MESSAGE,
    ],
    [
      'a host that starts with it',
      'https://orchestration-proxy.civitai.com.evil.example/v2/consumer/blobs/x',
      EXTERNAL_MESSAGE,
    ],
  ])('does not trust %s', async (_, url, message) => {
    expect(await gate([url], 'iterateGenerate', message)).toBe('refused');
  });

  it('refuses a key in an allowed external url when neither issue record store can be read', async () => {
    const foreign = `https://replicate.example/pbxt/${KEY}/out.png`;
    // Either store alone being unreadable is not enough.
    redisMock.sysRedis.mGet.mockRejectedValueOnce(new Error('redis down'));
    expect(await gate([foreign], 'generateFromGraph')).toBe('accepted');
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

  it('reads a scheme as a url parser does: any case, a tab inside dropped', () => {
    const urls = ['HTTPS:example.com/a.png', 'ht\ttps:example.com/b.png'];
    expect(generationInputUrlsIn({ a: urls[0], b: urls[1] })).toEqual(urls);
    expect(opaqueInputUrlsIn({ u: 'HTTPS://example.com/a.png' }).urls).toEqual([
      'HTTPS://example.com/a.png',
    ]);
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
    expect(opaqueInputUrlsIn({ field: base64(4 * MiB - 5) })).toEqual({
      urls: [],
      tooDeep: false,
      tooLarge: false,
    });
    expect(opaqueInputUrlsIn({ field: base64(4 * MiB - 4) }).tooLarge).toBe(true);
    expect(opaqueInputUrlsIn({ a: base64(2.1 * MiB), b: base64(2.1 * MiB) }).tooLarge).toBe(true);
  });

  it('counts the text of a value split into lines once', () => {
    const text = `https://example.com/a\nhttps://example.com/b ${base64(3 * MiB)}`;
    expect(opaqueInputUrlsIn({ text }).tooLarge).toBe(false);
  });

  it('reads up to 65,536 line breaks across its strings, and reports more as too large', () => {
    const breaks = (n: number) => `${'x\n'.repeat(n)}a:`;
    expect(opaqueInputUrlsIn({ text: breaks(65_536) }).tooLarge).toBe(false);
    expect(opaqueInputUrlsIn({ text: breaks(65_537) }).tooLarge).toBe(true);
    expect(opaqueInputUrlsIn({ a: breaks(40_000), b: breaks(40_000) }).tooLarge).toBe(true);
    // Text that does not split counts too, and a run of breaks is one.
    expect(opaqueInputUrlsIn({ text: 'x\n'.repeat(65_537) }).tooLarge).toBe(true);
    expect(opaqueInputUrlsIn({ text: `x${'\r\n'.repeat(70_000)}y` }).tooLarge).toBe(false);
  });

  it('collects up to 4,096 values of up to 64 KiB in all, and reports more as too large', () => {
    // Keys overlap: each segment ends one key and its last 8 characters start the next.
    const keys = (n: number) =>
      `see 00000000${Array.from(
        { length: n },
        (_, i) => `-0000-4000-8000-${i.toString(16).padStart(12, '0')}`
      ).join('')}`;
    // As many whole keys as fit in 64 KiB, then one more.
    expect(opaqueInputUrlsIn({ text: keys(1820) })).toMatchObject({ tooLarge: false });
    expect(opaqueInputUrlsIn({ text: keys(1820) }).urls).toHaveLength(1820);
    expect(opaqueInputUrlsIn({ text: keys(1821) }).tooLarge).toBe(true);
    // More keys than a call takes as arguments: refused, not a stack overflow.
    expect(opaqueInputUrlsIn({ text: keys(140_000) }).tooLarge).toBe(true);
    // Short urls, under the length cap in all, but one value too many.
    const list = Array.from({ length: 4097 }, (_, i) => `http://a/${i.toString(36)}`);
    expect(opaqueInputUrlsIn({ list }).tooLarge).toBe(true);
    expect(opaqueInputUrlsIn({ list: list.slice(1) }).tooLarge).toBe(false);
    // A value repeated is collected, and counted, once.
    const repeated = new Array(10_000).fill(`https://image.civitai.com/x/${OKEY}/original=true`);
    expect(opaqueInputUrlsIn({ repeated })).toEqual({
      urls: [repeated[0]],
      tooDeep: false,
      tooLarge: false,
    });
  });

  it('decodes up to 1 MiB of escaped text, and reports more as too large', () => {
    const escaped = (n: number) => 'A%41'.repeat(n / 4);
    expect(opaqueInputUrlsIn({ text: escaped(MiB) }).tooLarge).toBe(false);
    expect(opaqueInputUrlsIn({ text: escaped(MiB + 4) }).tooLarge).toBe(true);
    // Escapes nested eight deep across 4 MiB: refused before it is decoded, not read for seconds.
    const nested = '%2525252525252525252541'.repeat(Math.floor((4 * MiB - 64) / 23));
    expect(opaqueInputUrlsIn({ text: nested }).tooLarge).toBe(true);
    // Split text whose lines are too short to hold a key is still decoded whole.
    // A url, then prose lines (no scheme to parse) each shorter than a key: only the budget stops it.
    const shortLines = `https://x.y/\n${'%2525252541 xxxxxxxxxxxxxxxxxxxxxx\n'.repeat(40_000)}`;
    expect(opaqueInputUrlsIn({ text: shortLines }).tooLarge).toBe(true);
    // The budget is one per walk: two halves of it add up.
    const half = escaped(MiB / 2 + 4);
    expect(opaqueInputUrlsIn({ a: half, b: half }).tooLarge).toBe(true);
  });

  it('parses up to 32,768 strings that start like a url, and reports more as too large', () => {
    const list = new Array(32_769).fill('a:b');
    expect(opaqueInputUrlsIn({ list }).tooLarge).toBe(true);
    expect(opaqueInputUrlsIn({ list: list.slice(1) }).tooLarge).toBe(false);
    // Text with no scheme is not parsed, so it does not count.
    expect(opaqueInputUrlsIn({ list: new Array(40_000).fill('ab') }).tooLarge).toBe(false);
  });

  it('reads text after a url scheme of any length when its host is ASCII', () => {
    const prose = 'opens fine, and I have tried restarting it more than once today '.repeat(6);
    for (const u of [
      `http://localhost:7860 ${prose}`,
      `HTTPS: why does my site show as insecure ${prose}`,
      `File: summary of the meeting notes ${prose}`,
      `https://${'a'.repeat(10_000)}.com/a.png`,
      `ws://${'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(28_000)}/`,
      `https://u:${'a'.repeat(400)}@h.example.com/a.png`,
    ])
      expect(opaqueInputUrlsIn({ u }).tooLarge).toBe(false);
    // A scheme a parser does not convert a host for: non-ASCII text after it costs nothing.
    const distinct = Array.from({ length: 8000 }, (_, j) => String.fromCharCode(0x4e00 + j));
    expect(opaqueInputUrlsIn({ u: `Note: ${distinct.join('')}` }).tooLarge).toBe(false);
  });

  it('budgets the work of converting non-ASCII hosts, and reports more as too large', () => {
    // Distinct characters, as a parser's conversion costs the most for them.
    const cjk = (n: number, from = 0) =>
      Array.from({ length: n }, (_, j) => String.fromCharCode(0x4e00 + from + j)).join('');
    // One host: its length times its distinct characters, plus a parse, is the cost.
    expect(opaqueInputUrlsIn({ u: `ws://${cjk(5791)}/` }).tooLarge).toBe(false);
    expect(opaqueInputUrlsIn({ u: `ws://${cjk(5792)}/` }).tooLarge).toBe(true);
    // Many short hosts: the fixed cost per parse adds up.
    const short = (k: number) =>
      Array.from({ length: k }, (_, i) => `ws://${cjk(64, (i * 64) % 20_000)}/`);
    expect(opaqueInputUrlsIn({ list: short(2730) }).tooLarge).toBe(false);
    expect(opaqueInputUrlsIn({ list: short(2731) }).tooLarge).toBe(true);
    // Escapes and `xn--` hide what a host decodes to, so they are charged its length squared.
    expect(opaqueInputUrlsIn({ u: `ws://${'%41'.repeat(1930)}/` }).tooLarge).toBe(false);
    expect(opaqueInputUrlsIn({ u: `ws://${'%41'.repeat(1931)}/` }).tooLarge).toBe(true);
    expect(opaqueInputUrlsIn({ u: `ws://xn--${'a'.repeat(5800)}/` }).tooLarge).toBe(true);
    // A host too long to map cheaply is refused unmapped, however few its characters.
    const accented = String.fromCharCode(0xe9);
    expect(opaqueInputUrlsIn({ u: `ws://${accented.repeat(64 * 1024)}/` }).tooLarge).toBe(false);
    expect(opaqueInputUrlsIn({ u: `ws://${accented.repeat(64 * 1024 + 1)}/` }).tooLarge).toBe(true);
    // A run of combining marks a parser must reorder is charged its length squared, unmapped.
    const marks = (n: number) =>
      `a${String.fromCharCode(0x300).repeat(n)}${String.fromCharCode(0x316).repeat(n)}`;
    const normalize = vi.spyOn(String.prototype, 'normalize');
    try {
      // Under the length past which a host is refused unmapped: only the marks refuse it.
      expect(opaqueInputUrlsIn({ u: `ws://${marks(2 ** 15 - 2)}/` }).tooLarge).toBe(true);
      // Refused before the reordering is paid for, not after.
      expect(normalize).not.toHaveBeenCalled();
    } finally {
      normalize.mockRestore();
    }
    // A run split by marks NFKC makes (halfwidth katakana), or by characters a parser deletes
    // (a soft hyphen), is one run to the parser: charged whole, refused before it is mapped.
    const ch = (code: number) => String.fromCharCode(code);
    const halfwidth = `a${(ch(0x300) + ch(0xff9e)).repeat(32_000)}`;
    const softSplit = `a${(ch(0x300) + ch(0xad)).repeat(16_000)}${(ch(0x316) + ch(0xad)).repeat(
      16_000
    )}`;
    for (const host of [halfwidth, softSplit]) {
      const spy = vi.spyOn(String.prototype, 'normalize');
      try {
        expect(opaqueInputUrlsIn({ u: `ws://${host}/` }).tooLarge).toBe(true);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    }
    expect(opaqueInputUrlsIn({ u: `ws://${marks(2000)}/` }).tooLarge).toBe(false);
    expect(opaqueInputUrlsIn({ u: `ws://${marks(3000)}/` }).tooLarge).toBe(true);
    // The marks add to the rest of the host's cost.
    expect(opaqueInputUrlsIn({ u: `ws://${cjk(3000)}/` }).tooLarge).toBe(false);
    expect(opaqueInputUrlsIn({ u: `ws://${cjk(3000)}${marks(2000)}/` }).tooLarge).toBe(true);
    // A character the parser expands (a square katakana is six) is charged as expanded.
    const square = String.fromCharCode(0x3316).repeat(2000);
    expect(opaqueInputUrlsIn({ u: `ws://${cjk(2600)}${square}/` }).tooLarge).toBe(true);
    expect(opaqueInputUrlsIn({ u: `ws://${cjk(2600)}${square.slice(0, 1000)}/` }).tooLarge).toBe(
      false
    );
    // Prose that repeats a few characters costs little, however long: a message after a link.
    const hiragana = (n: number) =>
      Array.from({ length: n }, (_, j) => String.fromCharCode(0x3042 + (j % 80))).join('');
    // A percent sign that is not an escape hides nothing, so it is not charged as one.
    const messages = Array.from({ length: 6 }, () => `https://civitai.com 50% ${hiragana(8000)}`);
    expect(opaqueInputUrlsIn({ messages }).tooLarge).toBe(false);
  });

  it('reports too many values as too large', () => {
    // The root, the field name and the array are three values.
    expect(opaqueInputUrlsIn({ list: new Array(262_141).fill(0) }).tooLarge).toBe(false);
    expect(opaqueInputUrlsIn({ list: new Array(262_142).fill(0) }).tooLarge).toBe(true);
  });

  it('reads a long run of spaces in linear time', () => {
    const value = `a${' '.repeat(1_000_000)}b`;
    const started = performance.now();
    expect(opaqueInputUrlsIn({ value }).urls).toEqual([]);
    // Linear is milliseconds, the quadratic form minutes at this length: the bound sits far from
    // both, so load cannot redden it and only a quadratic scan can.
    expect(performance.now() - started).toBeLessThan(5000);
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
    ).toEqual(['https://civitai.com/models/123', 'https://example.com/a.png', OCDN, OKEY]);
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

/**
 * A chat App Block: the registry `chat-completion` step's params, walked as the router walks them
 * (`opaqueInputUrlsIn` with the step's own `freeTextParamPaths`, then the gate in opaqueInput
 * mode), with the external-host refusal ON.
 */
describe('a chat App Block step, with the external-host refusal on', () => {
  const CDN = `https://image.civitai.com/x/${KEY}/original=true`;
  const run = (
    inputs: unknown,
    entry: 'appBlocksStep' | 'appBlocksPassThrough' | 'appBlocksWorkflow',
    freeTextPaths?: readonly string[]
  ) => {
    const { urls, tooDeep, tooLarge } = opaqueInputUrlsIn(inputs, freeTextPaths);
    expect({ tooDeep, tooLarge }).toEqual({ tooDeep: false, tooLarge: false });
    return assertGenerationInputsUsable({
      urls,
      userId: CALLER,
      entry,
      isApiCaller: false,
      opaqueInput: true,
      now: AFTER,
    }).then(
      () => 'accepted',
      (e: unknown) => {
        if (e instanceof TRPCError && e.code === 'BAD_REQUEST') return `refused: ${e.message}`;
        throw e;
      }
    );
  };
  const chatPaths = () => getStep('chat-completion')?.freeTextParamPaths;
  const chat = (...contents: string[]) => ({
    model: 'deepseek/deepseek-chat',
    messages: contents.map((content) => ({ role: 'user', content })),
    maxTokens: 128,
  });
  const chatStep = (params: unknown) => run(params, 'appBlocksStep', chatPaths());

  beforeEach(() => {
    holder.refuseExternal = true;
  });

  it('accepts a message that is only a link to a model page', async () => {
    expect(await chatStep(chat('https://civitai.com/models/123'))).toBe('accepted');
  });

  it('accepts an external link on its own line, and a message that is only one', async () => {
    expect(
      await chatStep(chat('what do you think of this?\nhttps://example.com/a.png\nthanks'))
    ).toBe('accepted');
    expect(await chatStep(chat('https://example.com/a.png'))).toBe('accepted');
  });

  it('CONTROL: the same text is refused where nothing declares it free text', async () => {
    const params = chat('https://example.com/a.png');
    // A pass-through body, a field the step does not declare, and content that is not a string.
    expect(await run(params, 'appBlocksPassThrough')).toBe(`refused: ${EXTERNAL_MESSAGE}`);
    expect(await chatStep({ ...params, note: 'https://example.com/a.png' })).toBe(
      `refused: ${EXTERNAL_MESSAGE}`
    );
    expect(
      await chatStep({
        ...params,
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }],
          },
        ],
      })
    ).toBe(`refused: ${EXTERNAL_MESSAGE}`);
  });

  it('INVARIANT GUARD: a keyed CDN link with a trailing-dot host in message text is collected whole, and checked as an image input', async () => {
    // A civitai host is accepted by name, so the trailing dot must not change the outcome.
    const dotted = `https://image.civitai.com./x/${KEY}/original=true`;
    expect(opaqueInputUrlsIn(chat(dotted), chatPaths()).urls).toContain(dotted);
    await recordUploadKeyOwner(KEY, OTHER);
    expect(await chatStep(chat(dotted))).toBe(`refused: ${GENERATION_IMAGE_UNAVAILABLE_MESSAGE}`);
  });

  it("refuses another user's private image named in message text: a CDN link, a bare key, or among words", async () => {
    await givenImage();
    // Control: while the image is public, each passes.
    for (const content of [CDN, KEY, `what is in this picture?\n${CDN}`, `see ${CDN} please`])
      expect(await chatStep(chat(content))).toBe('accepted');
    await holder.db.exec(`UPDATE "Post" SET availability = 'Private'`);
    for (const content of [CDN, KEY, `what is in this picture?\n${CDN}`, `see ${CDN} please`])
      expect(await chatStep(chat(content))).toBe(
        `refused: ${GENERATION_IMAGE_UNAVAILABLE_MESSAGE}`
      );
  });

  it('refuses a CDN link in message text naming a key issued to another user, as an image input', async () => {
    await recordUploadKeyOwner(KEY, OTHER);
    expect(await chatStep(chat(CDN))).toBe(`refused: ${GENERATION_IMAGE_UNAVAILABLE_MESSAGE}`);
  });

  it('a plain page link outside chat message text is still refused: a workflow text field, a pass-through body', async () => {
    const page = 'https://civitai.com/models/123';
    const steps = [
      { $type: 'imageUpscaler', input: { image: { $ref: '$arguments', path: 'prompt' } } },
    ];
    expect(await run([steps.map((s) => s.input), { prompt: page }], 'appBlocksWorkflow')).toBe(
      `refused: ${PAGE_LINK_MESSAGE}`
    );
    expect(await run(chat(page), 'appBlocksPassThrough')).toBe(`refused: ${PAGE_LINK_MESSAGE}`);
    // Control: the same link as chat message text on the registry step passes.
    expect(await chatStep(chat(page))).toBe('accepted');
  });

  it('CONTROL: only a TOP-LEVEL messages list is free text, not one nested in another field', async () => {
    const url = 'https://example.com/a.png';
    expect(await chatStep({ ...chat('hello'), note: { messages: [{ content: url }] } })).toBe(
      `refused: ${EXTERNAL_MESSAGE}`
    );
    // The same link as the top-level message content passes.
    expect(await chatStep(chat(url))).toBe('accepted');
  });

  describe('a tool the chat declares to the model', () => {
    const SCHEMA_URL = 'https://json-schema.org/draft/2020-12/schema';
    // The shape a block echoes from the tool registry: zod's `z.toJSONSchema` output.
    const zodSchema = {
      $schema: SCHEMA_URL,
      type: 'object',
      properties: { query: { type: 'string' } },
      additionalProperties: false,
    };
    const withTool = (fn: Record<string, unknown>) => ({
      ...chat('hello'),
      tools: [{ type: 'function', function: { name: 'search_models', ...fn } }],
    });

    // 🔴 THE PRODUCTION REPRO: every chat App Block message carrying a registry tool was refused.
    it('accepts a tool whose parameters carry the $schema dialect url', async () => {
      expect(await chatStep(withTool({ description: 'Search', parameters: zodSchema }))).toBe(
        'accepted'
      );
    });

    it('accepts urls anywhere in a tool: description, $id, a $ref, a nested string, a key', async () => {
      const parameters = {
        $id: 'https://example.com/schemas/search.json',
        type: 'object',
        properties: {
          image: { $ref: 'https://example.com/schemas/image.json' },
          ref: { $ref: '$arguments', path: 'https://example.com/a.png' },
          'https://example.com/a.png': { type: 'string', examples: ['https://example.com/a.png'] },
        },
      };
      expect(
        await chatStep(
          withTool({ description: 'Looks up https://example.com/a.png for you', parameters })
        )
      ).toBe('accepted');
    });

    it('CONTROL: the same $schema url is refused where nothing declares it text', async () => {
      const refused = `refused: ${EXTERNAL_MESSAGE}`;
      const params = withTool({ parameters: zodSchema });
      // A pass-through body, a workflow, and an undeclared field of the registry step.
      expect(await run(params, 'appBlocksPassThrough')).toBe(refused);
      expect(await run({ $schema: SCHEMA_URL }, 'appBlocksPassThrough')).toBe(refused);
      expect(
        await run([[{ prompt: 'a cat' }], { schema: { $schema: SCHEMA_URL } }], 'appBlocksWorkflow')
      ).toBe(refused);
      expect(await chatStep({ ...chat('hello'), schema: zodSchema })).toBe(refused);
      // A tool-level field beside `function` is not under the declared path either.
      expect(
        await chatStep({
          ...chat('hello'),
          tools: [{ type: 'function', function: { name: 'f' }, parameters: zodSchema }],
        })
      ).toBe(refused);
    });

    it("refuses another user's private image named in a tool description or schema", async () => {
      await givenImage();
      const cases = [
        withTool({ description: `see ${CDN}` }),
        withTool({ description: KEY }),
        withTool({ parameters: { type: 'object', description: CDN } }),
        withTool({ parameters: { type: 'object', properties: { [KEY]: { type: 'string' } } } }),
      ];
      // Control: while the image is public, each passes.
      for (const params of cases) expect(await chatStep(params)).toBe('accepted');
      await holder.db.exec(`UPDATE "Post" SET availability = 'Private'`);
      for (const params of cases)
        expect(await chatStep(params)).toBe(`refused: ${GENERATION_IMAGE_UNAVAILABLE_MESSAGE}`);
    });
  });

  it("CONTROL: only a message's declared field is free text, not a sibling field", async () => {
    const url = 'https://example.com/a.png';
    expect(
      await chatStep({
        ...chat('hello'),
        messages: [{ role: 'user', content: 'hello', name: url }],
      })
    ).toBe(`refused: ${EXTERNAL_MESSAGE}`);
    expect(
      await chatStep({ ...chat('hello'), messages: [{ role: 'user', content: url, name: 'n' }] })
    ).toBe('accepted');
  });

  it('a workflow: an external link in a text field a $ref wires into an image is still refused', async () => {
    const steps = [
      { name: 'gen', $type: 'imageGen', input: { prompt: 'a cat' } },
      { $type: 'imageUpscaler', input: { image: { $ref: '$arguments', path: 'prompt' } } },
    ];
    const inputs = [steps.map((step) => step.input), { prompt: 'https://example.com/a.png' }];
    expect(await run(inputs, 'appBlocksWorkflow')).toBe(`refused: ${EXTERNAL_MESSAGE}`);
  });
});
