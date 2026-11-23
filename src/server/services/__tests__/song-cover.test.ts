import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type * as Caches from '~/server/redis/caches';
import type * as FeatureFlags from '~/server/services/feature-flags.service';
import type * as ImageService from '~/server/services/image.service';
import type * as UrlOwnership from '~/server/services/image-url-ownership';
import type * as Orchestrator from '~/server/services/orchestrator/orchestrator.service';
import type { SessionUser } from '~/types/session';

/**
 * Setting a song's cover, with the `Image` and `Track` rows in PGlite: the song, the cover rows and
 * the link between them are real rows, so each test reads back what was stored.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const mocks = vi.hoisted(() => ({
  music: true,
  deleteImages: vi.fn(),
  createImageIngestionRequest: vi.fn(),
}));

vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  getFeatureFlagsLazy: () => ({ music: mocks.music }),
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  deleteImages: mocks.deleteImages,
}));
vi.mock('~/server/services/orchestrator/orchestrator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Orchestrator>()),
  createImageIngestionRequest: mocks.createImageIngestionRequest,
}));
vi.mock('~/server/utils/created-image-media-probe', () => ({
  probeCreatedImageMedia: vi.fn(async () => 'present'),
}));
vi.mock('~/server/services/image-url-ownership', async (importOriginal) => ({
  ...(await importOriginal<typeof UrlOwnership>()),
  assertClientImageUrlsUsable: vi.fn(async () => undefined),
  assertClientKeysIssuedToCaller: vi.fn(async () => undefined),
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  preventReplicationLag: vi.fn(async () => undefined),
}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof Caches>();
  return {
    ...actual,
    imageMetadataCache: { ...actual.imageMetadataCache, refresh: vi.fn(async () => undefined) },
  };
});

import { setSongCoverSchema } from '~/server/schema/image.schema';
import { setSongCover } from '~/server/services/post.service';

const OWNER = 5;
const OTHER = 6;
const SONG = 7;
const POST = 70;
const NEW_KEY = '3f6c2b91-0d84-4a15-9e70-c2b8a4d15e33';

const owner = { id: OWNER } as SessionUser;
const stranger = { id: OTHER } as SessionUser;
const moderator = { id: 99, isModerator: true } as SessionUser;

let db: PGlite;
let nextId = 1000;

type Row = {
  id: number;
  userId: number;
  postId: number | null;
  type: string;
  url: string;
  metadata: Record<string, unknown> | null;
  ingestion: string;
  nsfwLevel: number;
  blockedFor: string | null;
};

async function rows(where: string, params: unknown[]) {
  return (
    await db.query<Row>(
      `SELECT id, "userId", "postId", type, url, metadata, ingestion, "nsfwLevel", "blockedFor"
       FROM "Image" WHERE ${where}`,
      params
    )
  ).rows;
}
const row = async (id: number) => (await rows('id = $1', [id]))[0];
/** A row as Prisma returns it for `select`. */
const picked = (found: Row | undefined, select?: Record<string, boolean>) =>
  !found
    ? null
    : select
    ? Object.fromEntries(Object.entries(found).filter(([key]) => select[key]))
    : found;

async function insert(values: Partial<Row> & { id: number; userId: number }) {
  await db.query(
    `INSERT INTO "Image" (id, "userId", "postId", type, url, metadata) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      values.id,
      values.userId,
      values.postId ?? null,
      values.type ?? 'image',
      values.url ?? `key-${values.id}`,
      values.metadata ?? null,
    ]
  );
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "MediaType" AS ENUM ('image', 'video', 'audio');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, type "MediaType" NOT NULL,
      url text NOT NULL, metadata jsonb, ingestion text NOT NULL DEFAULT 'Pending',
      "nsfwLevel" int NOT NULL DEFAULT 0, "blockedFor" text, "updatedAt" timestamp
    );
    CREATE TABLE "Track" (
      "imageId" int PRIMARY KEY REFERENCES "Image"(id) ON DELETE CASCADE,
      "coverImageId" int UNIQUE REFERENCES "Image"(id) ON DELETE SET NULL,
      genre text
    );
  `);
  const INT4_OID = 23;
  // Called as a tagged template by the code under test.
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = Prisma.sql(strings, ...values);
    const paramTypes = sql.values.map((v) => (Number.isInteger(v) ? INT4_OID : 0));
    return db.query(sql.text, sql.values, { paramTypes });
  };
  dbMock.dbWrite.$queryRaw.mockImplementation(
    (async (...a: Parameters<typeof run>) => (await run(...a)).rows) as never
  );
  // Only the Track writes: createImage's own raw statements read tables this test does not build.
  dbMock.dbWrite.$executeRaw.mockImplementation((async (...a: Parameters<typeof run>) =>
    a[0].join('').includes('"Track"') ? (await run(...a)).affectedRows ?? 0 : 0) as never);
});
afterAll(() => db.close());

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.music = true;
  mocks.createImageIngestionRequest.mockResolvedValue({
    data: { id: 'wf-cover' },
    useImageScanning: false,
  });
  await db.exec(`DELETE FROM "Image";`);
  await insert({
    id: SONG,
    userId: OWNER,
    postId: POST,
    type: 'audio',
    metadata: { duration: 120, title: 'Midnight Arcade', allowRemix: false },
  });

  dbMock.dbWrite.image.findUnique.mockImplementation((async ({
    where,
    select,
  }: {
    where: { id: number };
    select?: Record<string, boolean>;
  }) => picked(await row(where.id), select)) as never);
  dbMock.dbWrite.image.findFirst.mockImplementation((async ({
    where,
    select,
  }: {
    where: { url: string };
    select?: Record<string, boolean>;
  }) => picked((await rows('url = $1', [where.url]))[0], select)) as never);
  dbMock.dbWrite.image.create.mockImplementation((async ({
    data,
  }: {
    data: Partial<Row> & { userId: number };
  }) => {
    const id = ++nextId;
    await insert({ ...data, id });
    return { id };
  }) as never);
});

const upload = (overrides: Record<string, unknown> = {}) => ({
  url: NEW_KEY,
  type: 'image',
  mimeType: 'image/png',
  width: 512,
  height: 512,
  ...overrides,
});

/** Through the procedure's own input schema, as the router hands it over. */
const setCover = (user: SessionUser, overrides: Record<string, unknown> = {}, id = SONG) =>
  setSongCover({ ...setSongCoverSchema.parse({ id, cover: upload(overrides) }), user });

async function songMetadata() {
  return (await row(SONG)).metadata as Record<string, unknown>;
}
/** The song's linked cover: `Track.coverImageId`. */
async function linkedCover() {
  const { rows: found } = await db.query<{ coverImageId: number | null }>(
    `SELECT "coverImageId" FROM "Track" WHERE "imageId" = $1`,
    [SONG]
  );
  return found[0]?.coverImageId ?? undefined;
}
const link = (coverId: number) =>
  db.query(
    `INSERT INTO "Track" ("imageId", "coverImageId") VALUES ($1, $2)
     ON CONFLICT ("imageId") DO UPDATE SET "coverImageId" = EXCLUDED."coverImageId"`,
    [SONG, coverId]
  );

describe('setSongCover', () => {
  it("makes the upload the owner's postless cover row, links it to the song and sends it for scanning", async () => {
    const cover = await setCover(owner);

    const created = await row(cover.id);
    expect(created).toMatchObject({
      userId: OWNER,
      postId: null,
      type: 'image',
      url: NEW_KEY,
      metadata: { parentId: SONG },
    });
    expect(await linkedCover()).toBe(cover.id);
    // Nothing about the cover is written to the song's own metadata.
    expect(await songMetadata()).toEqual({
      duration: 120,
      title: 'Midnight Arcade',
      allowRemix: false,
    });
    expect(mocks.createImageIngestionRequest).toHaveBeenCalledWith(
      expect.objectContaining({ imageId: cover.id, url: NEW_KEY, type: 'image' })
    );
    expect(cover).toEqual({
      id: cover.id,
      url: NEW_KEY,
      ingestion: 'Pending',
      nsfwLevel: 0,
      blockedFor: null,
    });
  });

  it("lets a moderator set it, the row staying the song owner's", async () => {
    const cover = await setCover(moderator);

    expect((await row(cover.id)).userId).toBe(OWNER);
    expect(await linkedCover()).toBe(cover.id);
  });

  it('refuses anyone else, creating and linking nothing', async () => {
    await expect(setCover(stranger)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(await rows('id <> $1', [SONG])).toEqual([]);
    expect(await linkedCover()).toBeUndefined();
  });

  it('refuses an image, video or missing target that is not a song', async () => {
    await insert({ id: 8, userId: OWNER, postId: POST, type: 'image' });
    await insert({ id: 9, userId: OWNER, postId: POST, type: 'video' });

    await expect(setCover(owner, {}, 8)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(setCover(owner, {}, 9)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(setCover(owner, {}, 404)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await rows('id > $1', [9])).toEqual([]);
  });

  it('refuses a video or audio file as the cover', async () => {
    expect(() =>
      setSongCoverSchema.parse({ id: SONG, cover: upload({ type: 'video' }) })
    ).toThrow();
    expect(() =>
      setSongCoverSchema.parse({ id: SONG, cover: upload({ type: 'audio' }) })
    ).toThrow();
    await expect(
      setSongCover({ id: SONG, cover: upload({ type: 'video' }) as never, user: owner })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(setCover(owner, { mimeType: 'audio/mpeg' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });

    expect(await rows('id <> $1', [SONG])).toEqual([]);
  });

  it('refuses a user without the music flag', async () => {
    mocks.music = false;

    await expect(setCover(owner)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await rows('id <> $1', [SONG])).toEqual([]);
  });

  it('deletes the replaced cover through the image delete service, after the new one is linked', async () => {
    const first = await setCover(owner, { url: 'a1b2c3d4-0000-4000-8000-000000000001' });
    let linkedAtDelete: unknown;
    mocks.deleteImages.mockImplementation(async () => {
      linkedAtDelete = await linkedCover();
    });

    const second = await setCover(owner);

    expect(mocks.deleteImages).toHaveBeenCalledTimes(1);
    expect(mocks.deleteImages).toHaveBeenCalledWith([first.id], { actor: { id: OWNER } });
    expect(linkedAtDelete).toBe(second.id);
    expect(await linkedCover()).toBe(second.id);
  });

  it('gives each of two concurrent saves back the cover it replaced, deleting each once', async () => {
    const first = await setCover(owner, { url: 'a1b2c3d4-0000-4000-8000-000000000001' });

    const [a, b] = await Promise.all([
      setCover(owner, { url: 'a1b2c3d4-0000-4000-8000-000000000002' }),
      setCover(owner, { url: 'a1b2c3d4-0000-4000-8000-000000000003' }),
    ]);

    // One save replaced the first cover, the other replaced that save's cover.
    const deleted = mocks.deleteImages.mock.calls.map(([ids]) => ids as number[]).flat();
    const kept = await linkedCover();
    expect([a.id, b.id]).toContain(kept);
    expect(deleted.sort()).toEqual([first.id, kept === a.id ? b.id : a.id].sort());
  });

  it("never deletes a linked image that is not this song's own cover row", async () => {
    // Another user's image, the owner's post image, and the owner's image made for another song.
    await insert({ id: 20, userId: OTHER, metadata: { parentId: SONG } });
    await insert({ id: 21, userId: OWNER, postId: POST, metadata: { parentId: SONG } });
    await insert({ id: 22, userId: OWNER, metadata: { parentId: 123 } });

    for (const foreign of [20, 21, 22]) {
      await db.query(`DELETE FROM "Image" WHERE url = $1`, [NEW_KEY]);
      await link(foreign);

      const cover = await setCover(owner);

      expect(await linkedCover()).toBe(cover.id);
    }
    expect(mocks.deleteImages).not.toHaveBeenCalled();
  });

  it('refuses an upload key that already belongs to another image', async () => {
    await insert({ id: 30, userId: OWNER, postId: POST, url: NEW_KEY });

    await expect(setCover(owner)).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(await linkedCover()).toBeUndefined();
    expect(await rows('url = $1', [NEW_KEY])).toHaveLength(1);
  });

  it('links the row a failed earlier attempt left behind instead of creating a second one', async () => {
    await insert({ id: 31, userId: OWNER, url: NEW_KEY, metadata: { parentId: SONG } });

    const cover = await setCover(owner);

    expect(cover.id).toBe(31);
    expect(await linkedCover()).toBe(31);
    expect(await rows('url = $1', [NEW_KEY])).toHaveLength(1);
    expect(mocks.deleteImages).not.toHaveBeenCalled();
  });
});
