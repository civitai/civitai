import { serverCopyTablesSql } from '@civitai/db-queries/test/image-uses';
import { PGlite } from '@electric-sql/pglite';
import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as EnvClient from '~/env/client';
import type * as S3Utils from '~/utils/s3-utils';

/**
 * `blocks.persistUploadedGenerationSource`'s service, end to end on the server: a source image
 * the viewer picked (`useImageUpload({ purpose: 'generationSource' })` or a single
 * `OPEN_MEDIA_UPLOAD` image) arrives as a consumer blob url, and is copied through the SAME writer
 * `PERSIST_GENERATION_SOURCE` uses for an app's own outputs (`persistBlockGenerationSourceImage`:
 * hardened fetch, fit, store, `createImage` with the private provenance key), then waited on with
 * the REAL generation gate as the definition of `ready`.
 *
 * Why it exists: with `app-block-source-scanned-rows` ON the gate refuses every orchestrator url
 * an app sends, so a picked blob is unusable; the scanned row this writes is what the gate
 * accepts. The store and `createImage`'s INSERT are the stand-ins; the gate, the idempotency
 * lookup and the shared-grid and post reads are real, against one Postgres stand-in.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({
  db: null as unknown as PGlite,
  scannedRows: true,
  nextImageId: 7000,
  nextKey: 0,
  stored: [] as Buffer[],
  /** The keys the store stand-in minted in this test, in order. */
  minted: [] as string[],
  fetchBytes: null as Buffer | null,
  imageLocation: 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA',
}));
const createImage = vi.hoisted(() => vi.fn());

vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: {
    GENERATION_INPUT_REFUSE_EXTERNAL_HOSTS: 'generation-input-refuse-external-hosts',
    APP_BLOCK_SOURCE_SCANNED_ROWS: 'app-block-source-scanned-rows',
    APP_BLOCK_REFUSE_EXTERNAL_SOURCES: 'app-block-refuse-external-sources',
  },
  // A per-app rollout, as an ENTITY_ID segment answers: ON (while `scannedRows`) for app A only.
  isFlipt: async (flag: string, entityId?: string) =>
    flag === 'app-block-source-scanned-rows' && holder.scannedRows && entityId === 'apb_alpha',
  isFliptSync: (flag: string, entityId?: string) =>
    flag === 'app-block-source-scanned-rows' && holder.scannedRows && entityId === 'apb_alpha',
  readFliptBoolean: async (flag: string, entityId?: string) =>
    flag === 'app-block-source-scanned-rows' && holder.scannedRows && entityId === 'apb_alpha',
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
    const key = `00000000-0000-4000-9000-${n}`;
    holder.minted.push(key);
    return { key, backend: 'backblaze' };
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
  persistUploadedGenerationSource,
  uploadedSourceBlobId,
  UPLOADED_SOURCE_URL_MESSAGE,
  GENERATION_SOURCE_DEADLINE_MS,
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
const { BLOCK_IMAGE_MAX_BYTES } = await import('~/shared/constants/block-image-upload.constants');

const APP = 'appblk-alpha';
const OTHER_APP = 'appblk-beta';
/** App A's app block id: the flag is ON for it (see the `isFlipt` stand-in). */
const APP_BLOCK = 'apb_alpha';
/** App B's: the flag is OFF for it. */
const OTHER_APP_BLOCK = 'apb_beta';
const VIEWER = 42;
const OTHER_USER = 7;
/** A request budget long enough for the in-process fetch and store, short enough to wait out. */
const SHORT_BUDGET_MS = 3_000;
/** A consumer blob url as `uploadConsumerBlob` returns it: signed, on the orchestrator host. */
const BLOB_ID = 'ABC123.jpeg';
const BLOB_URL = `https://orchestration.civitai.com/v2/consumer/blobs/${BLOB_ID}?sig=x&exp=2030-01-01T00:00:00Z`;
const OTHER_BLOB_URL =
  'https://orchestration.civitai.com/v2/consumer/blobs/DEF456.jpeg?sig=y&exp=2030-01-01T00:00:00Z';

const png = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#336699' } })
    .png()
    .toBuffer();

function persist(over: Partial<Parameters<typeof persistUploadedGenerationSource>[0]> = {}) {
  return persistUploadedGenerationSource({
    userId: VIEWER,
    appId: APP,
    appBlockId: APP_BLOCK,
    url: BLOB_URL,
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

const imageCount = async () =>
  (await holder.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "Image"`)).rows[0].n;

const scan = (id: number, over = `ingestion = 'Scanned', "nsfwLevel" = 1`) =>
  holder.db.query(`UPDATE "Image" SET ${over} WHERE id = $1`, [id]);

/** The gate's answer for `url`, as an App Blocks entry would see it. */
async function gate(
  url: string,
  userId = VIEWER,
  entry: 'appBlocks' | 'appBlocksWorkflow' = 'appBlocks',
  appBlockId = APP_BLOCK
) {
  try {
    await assertGenerationInputsUsable({
      urls: [url],
      userId,
      entry,
      isApiCaller: false,
      appBlockLog: { appBlockId },
    });
    return 'accepted';
  } catch (e) {
    return `refused: ${(e as Error).message}`;
  }
}

/** Persists BLOB_URL, with the scan landing shortly after the row is written. */
async function persistAfterScan(
  over: Partial<Parameters<typeof persistUploadedGenerationSource>[0]> = {}
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

/** Persists BLOB_URL with the scan still pending when the call's own wait runs out. */
async function persistPending() {
  let createdId = 0;
  const base = createImage.getMockImplementation()!;
  createImage.mockImplementation(async (args) => {
    const created = await base(args);
    createdId = created.id;
    return created;
  });
  try {
    const out = await persist({ budgetMs: SHORT_BUDGET_MS });
    return { out, createdId };
  } finally {
    createImage.mockImplementation(base);
  }
}

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Post" (id int PRIMARY KEY, "publishedAt" timestamp(3),
      availability text NOT NULL DEFAULT 'Public', "tosViolation" boolean NOT NULL DEFAULT false);
    ${serverCopyTablesSql};
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
  holder.minted = [];
  holder.imageLocation = 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA';
  holder.fetchBytes = await png(640, 320);
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

describe('🔴 the url restriction: only a consumer blob on a trusted orchestrator host', () => {
  it('positive control: the blob url as uploaded is accepted, and its id read', () => {
    expect(uploadedSourceBlobId(BLOB_URL)).toBe(BLOB_ID);
  });

  it.each([
    ['a non-orchestrator host', `https://example.com/v2/consumer/blobs/${BLOB_ID}`],
    ['our image CDN', `https://image.civitai.com/v2/consumer/blobs/${BLOB_ID}`],
    [
      'a look-alike host that ends in the orchestrator name',
      `https://orchestration.civitai.com.example.net/v2/consumer/blobs/${BLOB_ID}`,
    ],
    [
      'a trusted host, a job asset path',
      'https://orchestration.civitai.com/v1/consumer/jobs/0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b/assets/a.png',
    ],
    ['a trusted host, a workflow output path', 'https://orchestration.civitai.com/v2/blobs/a.png'],
    [
      'a trusted host, a blob path with a trailing segment',
      `https://orchestration.civitai.com/v2/consumer/blobs/${BLOB_ID}/extra`,
    ],
    [
      'a trusted host, the blob path below another prefix',
      `https://orchestration.civitai.com/proxy/v2/consumer/blobs/${BLOB_ID}`,
    ],
    [
      'userinfo before the host',
      `https://user@orchestration.civitai.com/v2/consumer/blobs/${BLOB_ID}`,
    ],
    [
      'userinfo naming the trusted host before another',
      `https://orchestration.civitai.com@example.com/v2/consumer/blobs/${BLOB_ID}`,
    ],
    [
      'a port on the trusted host',
      `https://orchestration.civitai.com:8443/v2/consumer/blobs/${BLOB_ID}`,
    ],
    ['plain http', `http://orchestration.civitai.com/v2/consumer/blobs/${BLOB_ID}`],
    ['a fragment', `https://orchestration.civitai.com/v2/consumer/blobs/${BLOB_ID}#x`],
    [
      'a path a parser rewrites (dot segments)',
      'https://orchestration.civitai.com/v2/consumer/blobs/../../blobs/a.png',
    ],
    [
      'an upper-case host a parser rewrites',
      `https://ORCHESTRATION.civitai.com/v2/consumer/blobs/${BLOB_ID}`,
    ],
    ['a bare blob id', BLOB_ID],
    ['not a url', 'not a url'],
  ])('refuses %s, fetching and writing nothing', async (_label, url) => {
    expect(uploadedSourceBlobId(url)).toBeNull();
    await expect(persist({ url })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: UPLOADED_SOURCE_URL_MESSAGE,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(createImage).not.toHaveBeenCalled();
  });

  it('refuses a redirect OFF the output-host allowlist, before following it, and writes nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(null, { status: 302, headers: { location: 'https://example.com/a.png' } })
      )
    );
    await expect(persist()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'output url is not an allowed generation host',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(holder.stored).toHaveLength(0);
    expect(createImage).not.toHaveBeenCalled();
  });

  it('positive control: a SAME-host redirect is followed and the copy is written', async () => {
    const bytes = holder.fetchBytes!;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(null, { status: 301, headers: { location: '/v2/consumer/blobs/content/c' } })
        )
        .mockResolvedValueOnce(new Response(new Uint8Array(bytes), { status: 200 }))
    );
    const out = await persistAfterScan();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe(
      'https://orchestration.civitai.com/v2/consumer/blobs/content/c'
    );
    expect(out.ready).toBe(true);
  });

  it('refuses a body that is not an image, and writes nothing', async () => {
    holder.fetchBytes = Buffer.from('this is plain text, not an image at all');
    await expect(persist()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'generation output is not a supported image',
    });
    expect(holder.stored).toHaveLength(0);
    expect(createImage).not.toHaveBeenCalled();
  });

  it('refuses a body DECLARED over the byte cap, and writes nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Uint8Array(holder.fetchBytes!), {
            status: 200,
            headers: { 'content-length': String(BLOCK_IMAGE_MAX_BYTES + 1) },
          })
      )
    );
    await expect(persist()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'generation output is too large',
    });
    expect(holder.stored).toHaveLength(0);
    expect(createImage).not.toHaveBeenCalled();
  });

  it('refuses a body that IS over the byte cap without declaring it, and writes nothing', async () => {
    holder.fetchBytes = Buffer.alloc(BLOCK_IMAGE_MAX_BYTES + 1);
    await expect(persist()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'generation output is too large',
    });
    expect(holder.stored).toHaveLength(0);
    expect(createImage).not.toHaveBeenCalled();
  });

  it('refuses an image under 64 px, and writes nothing', async () => {
    holder.fetchBytes = await png(40, 300);
    await expect(persist()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'generation output is too small to use as a source (under 64px)',
    });
    expect(createImage).not.toHaveBeenCalled();
  });

  it('downscales an image over 2048 px into the source bounds and reports what it stored', async () => {
    holder.fetchBytes = await png(3000, 1500);
    const out = await persistAfterScan();
    expect({ width: out.width, height: out.height }).toEqual({ width: 2048, height: 1024 });
    const stored = await sharp(holder.stored[0]).metadata();
    expect({ width: stored.width, height: stored.height }).toEqual({ width: 2048, height: 1024 });
  });
});

describe('🔴 the written row: the viewer’s own, private, at a fresh key', () => {
  it('is owned by the viewer, carries ONLY the private key and the upload ref, and has no post', async () => {
    // Pending on purpose: the row as written, before any scan touches it.
    const { out } = await persistPending();
    expect(createImage).toHaveBeenCalledTimes(1);
    const args = createImage.mock.calls[0][0];
    expect(args.blockProvenance).toEqual({ key: 'blockGenerationSourceAppId', appId: APP });
    expect(args.userId).toBe(VIEWER);
    expect(args.postId).toBeUndefined();
    // Default ingestion: nothing marks the row as already scanned.
    expect(args).not.toHaveProperty('skipIngestion');
    const row = await imageRow(out.imageId);
    expect(row.userId).toBe(VIEWER);
    expect(row.postId).toBeNull();
    expect(row.ingestion).toBe('Pending');
    expect(row.metadata).toMatchObject({
      blockGenerationSourceAppId: APP,
      blockGenerationSourceRef: `upload:${BLOB_ID}`,
    });
    expect(row.metadata).not.toHaveProperty('blockPublishedAppId');
    expect(row.metadata).not.toHaveProperty('blockUploadedAppId');
  });

  it('stores the bytes under a FRESH key, never the url the caller sent', async () => {
    const out = await persistAfterScan();
    const row = await imageRow(out.imageId);
    // The key the store minted for THIS write, and nothing the caller sent.
    expect(holder.minted).toHaveLength(1);
    expect(row.url).toBe(holder.minted[0]);
    expect(row.url).not.toContain(BLOB_ID);
    expect(holder.stored[0].equals(holder.fetchBytes!)).toBe(true);
  });

  it('returns the full-size delivery url in the source-image shape', async () => {
    const out = await persistAfterScan();
    const key = (await imageRow(out.imageId)).url;
    expect(out.url).toBe(
      `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${key}/original=true/${key}.jpeg`
    );
    expect(civitaiHostedImageUrlSchema.parse(out.url)).toBe(out.url);
    expect({ width: out.width, height: out.height }).toEqual({ width: 640, height: 320 });
  });

  it('the app’s shared grid read returns it to its owner only, never to anyone else', async () => {
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

describe('the scan: pending, finished, failed', () => {
  it('ready: true once the scan lands inside the deadline', async () => {
    const out = await persistAfterScan();
    expect(out.ready).toBe(true);
  });

  it('ready: false while the scan is pending at the deadline; the gate says pending, then accepts', async () => {
    const { out, createdId } = await persistPending();
    expect(out.ready).toBe(false);
    expect(out.imageId).toBe(createdId);
    expect(await gate(out.url)).toBe(`refused: ${APP_SOURCE_PENDING_MESSAGE}`);
    await scan(createdId);
    expect(await gate(out.url)).toBe('accepted');
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
  ])('%s is an ERROR from the whole call, never a source', async (_label, set, message) => {
    const base = createImage.getMockImplementation()!;
    createImage.mockImplementation(async (args) => {
      const created = await base(args);
      await scan(created.id, set);
      return created;
    });
    await expect(persist()).rejects.toMatchObject({ message });
  });
});

describe('🔴 CLOSING CONDITION — app-block-source-scanned-rows ON, the real gate, App Blocks entries', () => {
  it('positive control: the flag is on, so the picked BLOB itself is refused for an app', async () => {
    expect(await gate(BLOB_URL)).toBe(`refused: ${APP_SOURCE_NOT_ON_CIVITAI_MESSAGE}`);
    expect(await gate(BLOB_URL, VIEWER, 'appBlocksWorkflow')).toBe(
      `refused: ${APP_SOURCE_NOT_ON_CIVITAI_MESSAGE}`
    );
  });

  it.each(['appBlocks', 'appBlocksWorkflow'] as const)(
    'the url this returns for that blob is ACCEPTED on %s, with no not-on-Civitai refusal',
    async (entry) => {
      const out = await persistAfterScan();
      expect(out.ready).toBe(true);
      expect(await gate(out.url, VIEWER, entry)).toBe('accepted');
    }
  );
});

describe('🔴 per app: the flag ON for app A and OFF for app B', () => {
  it('A: the picked blob is refused, its pick is kept as a scanned row and accepted', async () => {
    expect(await gate(BLOB_URL)).toBe(`refused: ${APP_SOURCE_NOT_ON_CIVITAI_MESSAGE}`);
    const out = await persistAfterScan();
    expect(out.ready).toBe(true);
    expect(await gate(out.url)).toBe('accepted');
  });

  it('A: its picked source, still unscanned, is refused as pending', async () => {
    const { out } = await persistPending();
    expect(out.ready).toBe(false);
    expect(await gate(out.url)).toBe(`refused: ${APP_SOURCE_PENDING_MESSAGE}`);
  });

  it.each(['appBlocks', 'appBlocksWorkflow'] as const)(
    'B: the same blob is accepted on %s, as before the flag existed',
    async (entry) => {
      expect(await gate(BLOB_URL, VIEWER, entry, OTHER_APP_BLOCK)).toBe('accepted');
    }
  );
});

describe('the flag flipping between the path query and the submit', () => {
  it('a scanned source made while ON is still accepted after the flag turns OFF', async () => {
    const out = await persistAfterScan();
    holder.scannedRows = false;
    expect(await gate(out.url)).toBe('accepted');
  });

  it('a blob taken while OFF is accepted while OFF, and refused once the flag turns ON (the pre-fix behaviour, by the gate)', async () => {
    holder.scannedRows = false;
    expect(await gate(BLOB_URL)).toBe('accepted');
    holder.scannedRows = true;
    expect(await gate(BLOB_URL)).toBe(`refused: ${APP_SOURCE_NOT_ON_CIVITAI_MESSAGE}`);
  });

  it('the writer does not read the flag: a call made while OFF still writes the scanned row', async () => {
    holder.scannedRows = false;
    const out = await persistAfterScan();
    expect(out.ready).toBe(true);
    holder.scannedRows = true;
    expect(await gate(out.url)).toBe('accepted');
  });
});

describe('🔴 ownership: no path hands an app another user’s row', () => {
  it('another user cannot generate from the viewer’s source, scanned or not', async () => {
    const { out, createdId } = await persistPending();
    expect(await gate(out.url, OTHER_USER)).toBe(
      `refused: ${GENERATION_IMAGE_UNAVAILABLE_MESSAGE}`
    );
    await scan(createdId);
    // Positive control: the owner is accepted on the same row.
    expect(await gate(out.url)).toBe('accepted');
    expect(await gate(out.url, OTHER_USER)).toBe(
      `refused: ${GENERATION_IMAGE_UNAVAILABLE_MESSAGE}`
    );
  });

  it('another viewer persisting the SAME blob gets a row of its own, never the viewer’s', async () => {
    const first = await persistAfterScan();
    const second = await persistAfterScan({ userId: OTHER_USER });
    expect(second.imageId).not.toBe(first.imageId);
    expect(second.url).not.toBe(first.url);
    expect((await imageRow(second.imageId)).userId).toBe(OTHER_USER);
    expect(createImage).toHaveBeenCalledTimes(2);
  });

  it('another app persisting the same blob for the same viewer gets a row of its own', async () => {
    const first = await persistAfterScan();
    const second = await persistAfterScan({ appId: OTHER_APP });
    expect(second.imageId).not.toBe(first.imageId);
    expect(createImage).toHaveBeenCalledTimes(2);
  });

  it('a repeat call for the same viewer, app and blob returns the SAME row and fetches nothing', async () => {
    const first = await persistAfterScan();
    const second = await persist();
    expect(second).toEqual({ ...first, ready: true });
    expect(createImage).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('another blob gets a row of its own', async () => {
    const first = await persistAfterScan();
    const second = await persistAfterScan({ url: OTHER_BLOB_URL });
    expect(second.imageId).not.toBe(first.imageId);
    expect(await imageCount()).toBe(2);
  });
});

describe('the deadline bounds the request', () => {
  it('a call whose budget is already spent writes nothing', async () => {
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

  it('shares the generation-source deadline', () => {
    expect(GENERATION_SOURCE_DEADLINE_MS).toBe(30_000);
  });
});
