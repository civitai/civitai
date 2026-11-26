import { PGlite } from '@electric-sql/pglite';
import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as EnvClient from '~/env/client';
import type * as S3Utils from '~/utils/s3-utils';

/**
 * `PERSIST_GENERATION_SOURCE`, end to end on the server: the REAL ownership resolution
 * (`resolveOwnedWorkflowOutputs` over a real `projectAppWorkflow`), the real fetch → fit →
 * store → `createImage` path (the store and `createImage`'s INSERT are the stand-ins), the real
 * idempotency lookup, the REAL generation gate (`assertGenerationInputsUsable`) as the scan
 * wait's definition of ready, and the REAL shared-grid and post reads — all against one Postgres
 * stand-in, so a claim about "the row" is a claim about the row those reads see.
 *
 * `createImage` is replaced by an INSERT that composes `metadata` as `createImage` does
 * (`{ ...metadata, [blockProvenance.key]: blockProvenance.appId }`); that composition is pinned
 * against the real function in `image-block-provenance-metadata.test.ts`.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({
  db: null as unknown as PGlite,
  scannedRows: true,
  nextImageId: 5000,
  nextKey: 0,
  stored: [] as Buffer[],
  fetchBytes: null as Buffer | null,
  imageLocation: 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA',
}));
const OWNED = vi.hoisted(() => vi.fn());
const createImage = vi.hoisted(() => vi.fn());

vi.mock('~/server/services/blocks/block-workflows.service', () => ({
  blockWorkflowOwnedByAppUser: OWNED,
}));
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: {
    GENERATION_INPUT_REFUSE_EXTERNAL_HOSTS: 'generation-input-refuse-external-hosts',
    APP_BLOCK_SOURCE_SCANNED_ROWS: 'app-block-source-scanned-rows',
    APP_BLOCK_REFUSE_EXTERNAL_SOURCES: 'app-block-refuse-external-sources',
  },
  isFlipt: async (flag: string) => flag === 'app-block-source-scanned-rows' && holder.scannedRows,
  isFliptSync: (flag: string) => flag === 'app-block-source-scanned-rows' && holder.scannedRows,
  readFliptBoolean: async (flag: string) =>
    flag === 'app-block-source-scanned-rows' && holder.scannedRows,
  ensureFliptInitialized: async () => undefined,
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { $query: async () => [] } }));
vi.mock('~/env/client', async (importOriginal) => {
  const actual = await importOriginal<typeof EnvClient>();
  const env = { ...actual.env };
  Object.defineProperty(env, 'NEXT_PUBLIC_IMAGE_LOCATION', { get: () => holder.imageLocation });
  return { ...actual, env };
});
vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Utils>()),
  uploadImageBufferToStore: vi.fn(async (bytes: Buffer) => {
    holder.stored.push(bytes);
    const n = String(holder.nextKey++).padStart(12, '0');
    return { key: `00000000-0000-4000-8000-${n}`, backend: 'backblaze' };
  }),
}));
vi.mock('~/server/utils/image-blurhash', () => ({
  tryComputeImageBlurhash: async () => null,
  blurhashMetadata: () => ({}),
}));
vi.mock('~/server/services/image.service', () => ({ createImage }));
vi.mock('~/server/services/user-preferences.service', () => ({
  getAllHiddenForUser: async () => ({
    hiddenUsers: [],
    blockedUsers: [],
    blockedByUsers: [],
    hiddenTags: [],
  }),
}));

const raw = () => pgliteRaw(holder.db).queryRaw;
dbMock.dbWrite.$queryRaw.mockImplementation(((...a: Parameters<ReturnType<typeof raw>>) =>
  raw()(...a)) as never);
dbMock.dbRead.$queryRaw.mockImplementation(((...a: Parameters<ReturnType<typeof raw>>) =>
  raw()(...a)) as never);

const {
  persistBlockGenerationSource,
  waitForGenerationSource,
  generationSourceUrl,
  GENERATION_SOURCE_DEADLINE_MS,
  GENERATION_SOURCE_INDEX_OUT_OF_RANGE_MESSAGE,
  GENERATION_SOURCE_OUTPUT_UNAVAILABLE_MESSAGE,
} = await import('~/server/services/blocks/block-generation-source.service');
const {
  assertGenerationInputsUsable,
  APP_SOURCE_PENDING_MESSAGE,
  APP_SOURCE_UNUSABLE_MESSAGE,
  APP_SOURCE_NOT_ON_CIVITAI_MESSAGE,
  GENERATION_IMAGE_UNAVAILABLE_MESSAGE,
} = await import('~/server/services/generation-input-urls');
const { getBlockGatedImagesByIds } = await import(
  '~/server/services/blocks/block-gated-images.service'
);
const { resolveAppPublishedImages } = await import('~/server/services/blocks/block-post.service');
const { civitaiHostedImageUrlSchema } = await import('~/server/schema/blocks/civitai-image-url');

const APP = 'appblk-alpha';
const OTHER_APP = 'appblk-beta';
const VIEWER = 42;
const OTHER_USER = 7;
const WF = 'wf_src_1';
/** A request budget long enough for the in-process fetch and store, short enough to wait out. */
const SHORT_BUDGET_MS = 3_000;
const ALLOWED_OUTPUT = 'https://orchestration.civitai.com/v2/blobs/a.png';
const OFF_HOST_OUTPUT = 'https://evil.example/b.png';
const SECOND_OUTPUT = 'https://orchestration.civitai.com/v2/blobs/c.png';

function workflow(over: Record<string, unknown> = {}) {
  return {
    status: 'succeeded',
    tags: [`app-block:${APP}`],
    steps: [
      {
        $type: 'textToImage',
        output: {
          images: [
            { url: ALLOWED_OUTPUT, available: true, width: 640, height: 320, nsfwLevel: 'pg' },
            { url: OFF_HOST_OUTPUT, available: true, width: 640, height: 320, nsfwLevel: 'pg' },
            { url: SECOND_OUTPUT, available: true, width: 640, height: 320, nsfwLevel: 'pg' },
          ],
        },
      },
    ],
    ...over,
  };
}

const png = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#336699' } })
    .png()
    .toBuffer();

function persist(
  over: Partial<Parameters<typeof persistBlockGenerationSource>[0]> = {},
  wf: unknown = workflow()
) {
  return persistBlockGenerationSource({
    userId: VIEWER,
    appId: APP,
    appBlockId: 'apb_alpha',
    workflowId: WF,
    imageIndex: 0,
    getWorkflow: async () => wf,
    // Every browsing level: no fixture output is above the ceiling.
    ceiling: { maxBrowsingLevel: 31, serving: false },
    ...over,
  });
}

async function imageRow(id: number) {
  const { rows } = await holder.db.query<{
    id: number;
    userId: number;
    postId: number | null;
    url: string;
    ingestion: string;
    metadata: Record<string, unknown>;
  }>(`SELECT id, "userId", "postId", url, ingestion, metadata FROM "Image" WHERE id = $1`, [id]);
  return rows[0];
}

const scan = (id: number, over = `ingestion = 'Scanned', "nsfwLevel" = 1`) =>
  holder.db.query(`UPDATE "Image" SET ${over} WHERE id = $1`, [id]);

/** The gate's answer for `url`, as the App Blocks submit entry would see it. */
async function gate(url: string, userId = VIEWER) {
  try {
    await assertGenerationInputsUsable({
      urls: [url],
      userId,
      entry: 'appBlocks',
      isApiCaller: false,
      appBlockLog: { appBlockId: 'apb_alpha' },
    });
    return 'accepted';
  } catch (e) {
    return `refused: ${(e as Error).message}`;
  }
}

/** Drives a promise that sleeps on (fake) timers to completion. */
async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  const finish = () => {
    done = true;
  };
  p.then(finish, finish);
  // Until it settles: real work (the store, sharp, the database) runs between ticks, so a fixed
  // tick count could stop with the call still waiting on a fake timer.
  for (let i = 0; i < 20_000 && !done; i++) await vi.advanceTimersByTimeAsync(250);
  return p;
}

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Post" (id int PRIMARY KEY, "publishedAt" timestamp(3),
      availability text NOT NULL DEFAULT 'Public', "tosViolation" boolean NOT NULL DEFAULT false);
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "modelRestricted" boolean NOT NULL DEFAULT false,
      "userId" int NOT NULL,
      url text NOT NULL,
      "postId" int,
      "nsfwLevel" int NOT NULL DEFAULT 0,
      ingestion text NOT NULL DEFAULT 'Pending',
      width int,
      height int,
      "needsReview" text,
      poi boolean NOT NULL DEFAULT false,
      minor boolean NOT NULL DEFAULT false,
      "tosViolation" boolean NOT NULL DEFAULT false,
      "acceptableMinor" boolean NOT NULL DEFAULT false,
      "blockedFor" text,
      metadata jsonb
    );
    CREATE TABLE "TagsOnImageDetails" ("imageId" int, "tagId" int, disabled boolean);
    -- What the held-url check in the gated read reads, as minimal stand-ins.
    ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "modelVersionId" int;
    ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS metadata jsonb;
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int, meta jsonb);
    CREATE TABLE "Model" (id int PRIMARY KEY, meta jsonb);
    CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, details jsonb NOT NULL DEFAULT '{}',
      images jsonb NOT NULL DEFAULT '[]', "reportSentAt" timestamp(3));
    CREATE TABLE "ImageCdnModeratorDelete" (url text, "userId" int, "imageId" int, "csamReview" boolean NOT NULL DEFAULT false);
    CREATE TABLE "ImageCdnShopTakedown" (url text, "userId" int);
  `);
});

beforeEach(async () => {
  await holder.db.exec(`TRUNCATE "Post", "Image", "TagsOnImageDetails";`);
  holder.scannedRows = true;
  holder.stored = [];
  holder.imageLocation = 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA';
  holder.fetchBytes = await png(640, 320);
  OWNED.mockReset().mockResolvedValue(true);
  createImage
    .mockReset()
    .mockImplementation(
      async (args: {
        url: string;
        userId: number;
        width: number;
        height: number;
        metadata?: Record<string, unknown>;
        blockProvenance?: { key: string; appId: string };
        postId?: number;
      }) => {
        const id = holder.nextImageId++;
        const metadata = args.blockProvenance
          ? { ...args.metadata, [args.blockProvenance.key]: args.blockProvenance.appId }
          : args.metadata;
        await holder.db.query(
          `INSERT INTO "Image" (id, "userId", url, "postId", width, height, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [
            id,
            args.userId,
            args.url,
            args.postId ?? null,
            args.width,
            args.height,
            JSON.stringify(metadata ?? null),
          ]
        );
        return { id };
      }
    );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new Uint8Array(holder.fetchBytes!), { status: 200 }))
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ownership: refused before anything is fetched or written', () => {
  it.each([
    [
      'a workflow not in this app’s subqueue for this viewer',
      () => OWNED.mockResolvedValue(false),
      workflow(),
      { code: 'FORBIDDEN', message: 'workflow is not in this app subqueue' },
    ],
    [
      'a workflow the orchestrator tagged for another app',
      () => undefined,
      workflow({ tags: [`app-block:${OTHER_APP}`] }),
      { code: 'FORBIDDEN', message: 'workflow is not tagged for this app' },
    ],
    [
      'a workflow that has not finished',
      () => undefined,
      workflow({ status: 'processing' }),
      {
        code: 'BAD_REQUEST',
        message: 'workflow is still running — wait for it to finish before posting',
      },
    ],
  ])('refuses %s', async (_label, arrange, wf, expected) => {
    arrange();
    await expect(persist({}, wf)).rejects.toMatchObject(expected);
    expect(fetch).not.toHaveBeenCalled();
    expect(createImage).not.toHaveBeenCalled();
  });

  it('refuses an index past the outputs, by its own message', async () => {
    await expect(persist({ imageIndex: 3 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: GENERATION_SOURCE_INDEX_OUT_OF_RANGE_MESSAGE,
    });
    expect(createImage).not.toHaveBeenCalled();
  });

  it('refuses an output that is not available (off the output-host allowlist), not shifting to another', async () => {
    await expect(persist({ imageIndex: 1 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: GENERATION_SOURCE_OUTPUT_UNAVAILABLE_MESSAGE,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(createImage).not.toHaveBeenCalled();
  });

  // 🔴 `imageIndex` is a STABLE output position: a restricted output keeps its slot.
  // The workflow refused mature content (the paying pool) and output 0 is rated R.
  const restricted = () =>
    workflow({
      allowMatureContent: false,
      steps: [
        {
          $type: 'textToImage',
          output: {
            images: [
              { url: ALLOWED_OUTPUT, available: true, width: 640, height: 320, nsfwLevel: 'r' },
              { url: SECOND_OUTPUT, available: true, width: 640, height: 320, nsfwLevel: 'pg' },
            ],
          },
        },
      ],
    });

  it('refuses a RESTRICTED position by name, and fetches and writes nothing', async () => {
    await expect(persist({ imageIndex: 0 }, restricted())).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'output 0 is restricted',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(createImage).not.toHaveBeenCalled();
  });

  it('🔴 refuses an output STILL BEING RATED before anything is fetched or written', async () => {
    const held = workflow({
      allowMatureContent: false,
      steps: [
        {
          $type: 'textToImage',
          output: {
            images: [
              { url: ALLOWED_OUTPUT, available: true, width: 640, height: 320 },
              { url: SECOND_OUTPUT, available: true, width: 640, height: 320, nsfwLevel: 'pg' },
            ],
          },
        },
      ],
    });
    await expect(persist({ imageIndex: 0 }, held)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'output 0 is still being rated, try again shortly',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(createImage).not.toHaveBeenCalled();
    expect(holder.stored).toHaveLength(0);
  });

  it('refuses a BLOCKED position by the unavailable message, never shifting', async () => {
    const blocked = workflow({
      steps: [
        {
          $type: 'textToImage',
          output: {
            images: [
              {
                url: ALLOWED_OUTPUT,
                available: true,
                width: 640,
                height: 320,
                nsfwLevel: 'pg',
                blockedReason: 'Moderated',
              },
              { url: SECOND_OUTPUT, available: true, width: 640, height: 320, nsfwLevel: 'pg' },
            ],
          },
        },
      ],
    });
    await expect(persist({ imageIndex: 0 }, blocked)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: GENERATION_SOURCE_OUTPUT_UNAVAILABLE_MESSAGE,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(createImage).not.toHaveBeenCalled();
  });

  it('a restricted output still holds its position: index 2 of two outputs is out of range', async () => {
    // Index 2 is out of range (two positions), not "the second unrestricted output".
    await expect(persist({ imageIndex: 2 }, restricted())).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: GENERATION_SOURCE_INDEX_OUT_OF_RANGE_MESSAGE,
    });
    expect(createImage).not.toHaveBeenCalled();
  });

  describe('🔴 serving on: persist refuses what the poll restricts', () => {
    const SERVING = { maxBrowsingLevel: 31, serving: true };
    const withNa = () =>
      workflow({
        steps: [
          {
            $type: 'textToImage',
            output: {
              images: [
                { url: ALLOWED_OUTPUT, available: true, width: 640, height: 320, nsfwLevel: 'na' },
                { url: SECOND_OUTPUT, available: true, width: 640, height: 320, nsfwLevel: 'pg' },
              ],
            },
          },
        ],
      });

    it('an output rated `na` is refused, and nothing is fetched or written', async () => {
      await expect(persist({ imageIndex: 0, ceiling: SERVING }, withNa())).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'output 0 is restricted',
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(createImage).not.toHaveBeenCalled();
    });

    // The controls schedule the scan (persistAfterScan): a bare persist() of an accepted output
    // waits out the whole scan deadline in real time (~30 s each) to say nothing more.
    it('CONTROL: the rated output beside it persists', async () => {
      const wf = withNa();
      await persistAfterScan({ imageIndex: 1, ceiling: SERVING, getWorkflow: async () => wf });
      expect(createImage).toHaveBeenCalledTimes(1);
    });

    it('with serving off the `na` output is refused too, and nothing is fetched or written', async () => {
      await expect(persist({ imageIndex: 0 }, withNa())).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'output 0 is restricted',
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(createImage).not.toHaveBeenCalled();
    });

    it('CONTROL: with serving off the rated output beside it persists', async () => {
      const wf = withNa();
      await persistAfterScan({ imageIndex: 1, getWorkflow: async () => wf });
      expect(createImage).toHaveBeenCalledTimes(1);
    });
  });
});

describe('the written row is private', () => {
  it('🔴 carries the private key and NO published or uploaded key, owned by the viewer, with no post', async () => {
    const out = await persistAfterScan();
    expect(createImage).toHaveBeenCalledTimes(1);
    expect(createImage.mock.calls[0][0].blockProvenance).toEqual({
      key: 'blockGenerationSourceAppId',
      appId: APP,
    });
    expect(createImage.mock.calls[0][0].postId).toBeUndefined();
    const row = await imageRow(out.imageId);
    expect(row.userId).toBe(VIEWER);
    expect(row.postId).toBeNull();
    expect(row.metadata).toMatchObject({
      blockGenerationSourceAppId: APP,
      blockGenerationSourceRef: `${WF}#0`,
    });
    expect(row.metadata).not.toHaveProperty('blockPublishedAppId');
    expect(row.metadata).not.toHaveProperty('blockUploadedAppId');
  });

  it('🔴 the app’s shared grid read returns it to its owner only, never to anyone else', async () => {
    const out = await persistAfterScan();
    // Positive control: a scanned image this app PUBLISHED, by another viewer, IS returned.
    await holder.db.query(
      `INSERT INTO "Image" (id, "userId", url, "nsfwLevel", ingestion, width, height, metadata)
       VALUES (77, $1, 'published-key', 1, 'Scanned', 512, 512, $2::jsonb)`,
      [OTHER_USER, JSON.stringify({ blockPublishedAppId: APP })]
    );
    for (const [userId, expected] of [
      [VIEWER, [out.imageId, 77]],
      [OTHER_USER, [77]],
    ] as const) {
      const { images } = await getBlockGatedImagesByIds({
        imageIds: [out.imageId, 77],
        browsingLevel: 1,
        appId: APP,
        userId,
      });
      expect(images.map((i) => i.imageId)).toEqual(expected);
    }
  });

  it('is not postable by the app', async () => {
    const out = await persistAfterScan();
    await expect(
      resolveAppPublishedImages({
        imageIds: [out.imageId],
        userId: VIEWER,
        appId: APP,
        browsingLevel: 1,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'an image is not available to post' });
  });
});

/** Persists output 0, with the scan landing shortly after the row is written. */
async function persistAfterScan(
  over: Partial<Parameters<typeof persistBlockGenerationSource>[0]> = {}
) {
  const base = createImage.getMockImplementation()!;
  createImage.mockImplementation(async (args) => {
    const created = await base(args);
    setTimeout(() => void scan(created.id), 100);
    return created;
  });
  try {
    return await persist(over);
  } finally {
    createImage.mockImplementation(base);
  }
}

describe('the scan wait (the generation gate is the definition of ready)', () => {
  it('ready: true once the scan lands inside the deadline, and the gate accepts the url', async () => {
    const out = await persistAfterScan();
    expect(out.ready).toBe(true);
    expect(await gate(out.url)).toBe('accepted');
  });

  it('returns a url and dimensions in the source-image shape', async () => {
    const out = await persistAfterScan();
    const key = (await imageRow(out.imageId)).url;
    expect(out.url).toBe(
      `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${key}/original=true/${key}.jpeg`
    );
    expect(civitaiHostedImageUrlSchema.parse(out.url)).toBe(out.url);
    expect({ width: out.width, height: out.height }).toEqual({ width: 640, height: 320 });
  });

  it('ready: false at the deadline while the scan is still pending — after waiting the whole budget', async () => {
    await holder.db.query(
      `INSERT INTO "Image" (id, "userId", url, ingestion) VALUES (900, $1, $2, 'Pending')`,
      [VIEWER, '11111111-1111-4111-8111-111111111111']
    );
    const url = generationSourceUrl('11111111-1111-4111-8111-111111111111');
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const start = Date.now();
    const ready = await settle(
      waitForGenerationSource({
        url,
        userId: VIEWER,
        appBlockId: 'apb_alpha',
        deadline: start + GENERATION_SOURCE_DEADLINE_MS,
      })
    );
    expect(ready).toBe(false);
    expect(Date.now() - start).toBeGreaterThanOrEqual(GENERATION_SOURCE_DEADLINE_MS);
  });

  it('ready: true as soon as a scan lands mid-wait, well before the deadline', async () => {
    await holder.db.query(
      `INSERT INTO "Image" (id, "userId", url, ingestion) VALUES (901, $1, $2, 'Pending')`,
      [VIEWER, '22222222-2222-4222-8222-222222222222']
    );
    const url = generationSourceUrl('22222222-2222-4222-8222-222222222222');
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const start = Date.now();
    setTimeout(() => void scan(901), 5_000);
    const ready = await settle(
      waitForGenerationSource({
        url,
        userId: VIEWER,
        appBlockId: 'apb_alpha',
        deadline: start + GENERATION_SOURCE_DEADLINE_MS,
      })
    );
    expect(ready).toBe(true);
    expect(Date.now() - start).toBeLessThan(10_000);
  });

  it.each([
    [
      'a scan that BLOCKS the image',
      `ingestion = 'Blocked', "blockedFor" = 'moderated'`,
      GENERATION_IMAGE_UNAVAILABLE_MESSAGE,
    ],
    [
      'an image held for review',
      `ingestion = 'Scanned', "needsReview" = 'minor'`,
      APP_SOURCE_UNUSABLE_MESSAGE,
    ],
    ['a scan that errored', `ingestion = 'Error'`, APP_SOURCE_UNUSABLE_MESSAGE],
  ])('%s is an ERROR, not ready: false', async (_label, set, message) => {
    await holder.db.query(
      `INSERT INTO "Image" (id, "userId", url, ingestion) VALUES (902, $1, $2, 'Pending')`,
      [VIEWER, '33333333-3333-4333-8333-333333333333']
    );
    await scan(902, set);
    const url = generationSourceUrl('33333333-3333-4333-8333-333333333333');
    await expect(
      waitForGenerationSource({
        url,
        userId: VIEWER,
        appBlockId: 'apb_alpha',
        deadline: Date.now() + 1,
      })
    ).rejects.toMatchObject({ message });
  });

  it('a blocked scan surfaces from the whole call as an error', async () => {
    const base = createImage.getMockImplementation()!;
    createImage.mockImplementation(async (args) => {
      const created = await base(args);
      await scan(created.id, `ingestion = 'Blocked', "blockedFor" = 'moderated'`);
      return created;
    });
    await expect(persist()).rejects.toMatchObject({
      message: GENERATION_IMAGE_UNAVAILABLE_MESSAGE,
    });
  });
});

describe('🔴 gate seam: app-block-source-scanned-rows ON, the real gate, an App Blocks entry', () => {
  it('positive control: the flag is on (an orchestrator url is refused for an app)', async () => {
    expect(await gate(ALLOWED_OUTPUT)).toBe(`refused: ${APP_SOURCE_NOT_ON_CIVITAI_MESSAGE}`);
  });

  it('the returned url is refused as pending before the scan, and ACCEPTED after it', async () => {
    let createdId = 0;
    const base = createImage.getMockImplementation()!;
    createImage.mockImplementation(async (args) => {
      const created = await base(args);
      createdId = created.id;
      return created;
    });
    // A short budget on real timers, so the call's own wait runs out with the row still pending.
    // (Fake timers would race the request deadline against the real fetch / store / database work.)
    const out = await persist({ budgetMs: SHORT_BUDGET_MS });
    expect(out.ready).toBe(false);
    expect(out.imageId).toBe(createdId);
    expect(await gate(out.url)).toBe(`refused: ${APP_SOURCE_PENDING_MESSAGE}`);

    await scan(createdId);
    expect(await gate(out.url)).toBe('accepted');
    // To anyone else, the viewer's private source is just unavailable.
    expect(await gate(out.url, OTHER_USER)).toBe(
      `refused: ${GENERATION_IMAGE_UNAVAILABLE_MESSAGE}`
    );
  });
});

describe('idempotency: one row per (viewer, app, workflow, output)', () => {
  it('a repeat call returns the SAME row and fetches and writes nothing', async () => {
    const first = await persistAfterScan();
    const second = await persist();
    expect(second).toEqual({ ...first, ready: true });
    expect(createImage).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another output of the same workflow', { imageIndex: 2 }],
    ['the same index of another workflow', { workflowId: 'wf_src_2' }],
    ['another viewer', { userId: OTHER_USER }],
    ['another app', { appId: OTHER_APP }],
  ])('%s gets a row of its own', async (_label, over) => {
    const first = await persistAfterScan();
    const wf =
      (over as { appId?: string }).appId === OTHER_APP
        ? workflow({ tags: [`app-block:${OTHER_APP}`] })
        : workflow();
    const second = await persistAfterScan({ ...over, getWorkflow: async () => wf });
    expect(second.imageId).not.toBe(first.imageId);
    expect(createImage).toHaveBeenCalledTimes(2);
  });
});

describe('fitting the bytes into the source-image bounds', () => {
  it('downscales an output larger than 2048 px, keeping the aspect, and reports what it stored', async () => {
    holder.fetchBytes = await png(3000, 1500);
    const out = await persistAfterScan();
    expect({ width: out.width, height: out.height }).toEqual({ width: 2048, height: 1024 });
    const stored = await sharp(holder.stored[0]).metadata();
    expect({ width: stored.width, height: stored.height }).toEqual({ width: 2048, height: 1024 });
    expect(createImage.mock.calls[0][0]).toMatchObject({ width: 2048, height: 1024 });
  });

  it('stores an in-bounds output unchanged, at its measured size', async () => {
    const out = await persistAfterScan();
    expect(holder.stored[0].equals(holder.fetchBytes!)).toBe(true);
    expect({ width: out.width, height: out.height }).toEqual({ width: 640, height: 320 });
  });

  it('refuses an output under 64 px and writes nothing', async () => {
    holder.fetchBytes = await png(40, 300);
    await expect(persist()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'generation output is too small to use as a source (under 64px)',
    });
    expect(createImage).not.toHaveBeenCalled();
  });
});

describe('generationSourceUrl', () => {
  it('refuses to hand out a url the source schema would refuse', () => {
    holder.imageLocation = 'https://images.example.net/abc';
    expect(() => generationSourceUrl('44444444-4444-4444-8444-444444444444')).toThrow(
      'image delivery url is not a valid generation source'
    );
  });
});

describe('🔴 gate seam on the textToImage path (flag on): the persisted url as a `sourceImages` entry', () => {
  /**
   * What `createBlockTextToImageStep` gates: the REAL `buildTextToImageInput` output for a
   * page body carrying the source, its urls as `generationInputUrlsIn` reads them, through the
   * real gate on the `appBlocks` entry — the composition `assertGraphInputsUsable` performs
   * (module-private, so composed here from the same exported parts). That the router hands the
   * graph exactly that entry, and answers a pending refusal with `source-scan-pending`, is pinned
   * in `blocks.router.workflow.test.ts`.
   */
  async function textToImageGate(source: { url: string; width: number; height: number }) {
    const { buildTextToImageInput } = await import('~/server/services/blocks/workflow.service');
    const { generationInputUrlsIn } = await import('~/server/services/generation-input-urls');
    const input = buildTextToImageInput(
      {
        kind: 'textToImage',
        modelId: 7,
        modelVersionId: 99,
        params: { prompt: 'a cat', quantity: 1 },
        sourceImages: [source],
      } as never,
      {
        baseModel: 'SDXL 1.0',
        modelType: 'Checkpoint',
        checkpointVersionId: 99,
        checkpointBaseModel: 'SDXL 1.0',
        additionalResourceTypes: new Map(),
      }
    );
    const urls = generationInputUrlsIn(input);
    try {
      await assertGenerationInputsUsable({
        urls,
        userId: VIEWER,
        entry: 'appBlocks',
        isApiCaller: false,
        appBlockLog: { appBlockId: 'apb_alpha' },
      });
      return { urls, verdict: 'accepted' };
    } catch (e) {
      return { urls, verdict: `refused: ${(e as Error).message}` };
    }
  }

  it('pending before the scan, accepted after it', async () => {
    let createdId = 0;
    const base = createImage.getMockImplementation()!;
    createImage.mockImplementation(async (args) => {
      const created = await base(args);
      createdId = created.id;
      return created;
    });
    const out = await persist({ budgetMs: SHORT_BUDGET_MS });
    expect(out.ready).toBe(false);

    const source = { url: out.url, width: out.width, height: out.height };
    const pending = await textToImageGate(source);
    // Positive control: the source url is one of the urls the graph input carries.
    expect(pending.urls).toContain(out.url);
    expect(pending.verdict).toBe(`refused: ${APP_SOURCE_PENDING_MESSAGE}`);

    await scan(createdId);
    expect((await textToImageGate(source)).verdict).toBe('accepted');
  });
});

describe('🔴 the deadline bounds the whole request, the fetch included', () => {
  it('a fetch that never answers aborts at the deadline with a clear error, and writes no row', async () => {
    // Like a real fetch: it settles only when its signal aborts.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal;
            if (signal?.aborted) return reject(signal.reason);
            signal?.addEventListener('abort', () => reject(signal.reason));
          })
      )
    );
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const start = Date.now();
    const error = await settle(persist()).then(
      () => null,
      (e: unknown) => e
    );
    const elapsed = Date.now() - start;
    vi.useRealTimers();
    expect(error).toMatchObject({
      code: 'TIMEOUT',
      message: 'the generation output took too long to save — try again',
    });
    expect(elapsed).toBeGreaterThanOrEqual(GENERATION_SOURCE_DEADLINE_MS);
    expect(elapsed).toBeLessThan(GENERATION_SOURCE_DEADLINE_MS + 5_000);
    expect(holder.stored).toHaveLength(0);
    expect(createImage).not.toHaveBeenCalled();
    const { rows } = await holder.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "Image"`);
    expect(rows[0].n).toBe(0);
  });

  it('the budget is the request’s: a call whose budget is already spent writes nothing', async () => {
    // The budget's own timer never fires here, so a spent budget must be refused without it.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const error = await persist({ budgetMs: 0 }).then(
      () => null,
      (e: unknown) => e
    );
    vi.useRealTimers();
    expect(error).toMatchObject({ code: 'TIMEOUT' });
    expect(createImage).not.toHaveBeenCalled();
  });
});
