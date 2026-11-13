import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { POST_TITLE_MAX_LENGTH } from '~/server/common/constants';
import type * as Caches from '~/server/redis/caches';
import { updatePostImageSchema } from '~/server/schema/post.schema';
import type * as Blocklist from '~/server/services/blocklist.service';
import type * as HiddenMetaInvalidation from '~/server/services/hidden-meta-invalidation.service';

/**
 * A song's title and remix setting, with the `Image` row in PGlite: each test reads back the
 * metadata as stored, including what another save wrote while this one was in flight.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const mocks = vi.hoisted(() => ({
  throwOnBlockedUserContent: vi.fn(),
  invalidateHiddenImageMetadata: vi.fn(async () => undefined),
  /** Runs once, right after `updatePostImage` reads the row. */
  afterRead: undefined as undefined | (() => Promise<unknown>),
}));

vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Blocklist>()),
  throwOnBlockedUserContent: mocks.throwOnBlockedUserContent,
}));
vi.mock('~/server/services/hidden-meta-invalidation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof HiddenMetaInvalidation>()),
  invalidateHiddenImageMetadata: mocks.invalidateHiddenImageMetadata,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof Caches>();
  const refresh = vi.fn(async () => undefined);
  return {
    ...actual,
    imageMetadataCache: { ...actual.imageMetadataCache, refresh },
    imageMetaCache: { ...actual.imageMetaCache, refresh },
    userPostCountCache: { ...actual.userPostCountCache, refresh },
  };
});

import { updatePostImage } from '~/server/services/post.service';

const SONG = 9;
const IMAGE = 10;
const VIDEO = 11;
const stored = { duration: 120, bpm: 90, title: 'Old title' };

let db: PGlite;

async function insert(id: number, type: string, metadata: object | null) {
  await db.query(`INSERT INTO "Image" (id, type, metadata) VALUES ($1, $2, $3)`, [
    id,
    type,
    metadata,
  ]);
}
async function storedRow(id: number) {
  return (
    await db.query<{ metadata: Record<string, unknown> | null; hideMeta: boolean }>(
      `SELECT metadata, "hideMeta" FROM "Image" WHERE id = $1`,
      [id]
    )
  ).rows[0];
}
const storedMetadata = async (id = SONG) => (await storedRow(id)).metadata;

/** The cover link as `setSongCover` writes it. */
const linkCover = (coverId: number) =>
  db.query(
    `UPDATE "Image" SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('coverImageId', $1::int) WHERE id = $2`,
    [coverId, SONG]
  );

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Image" (
      id int PRIMARY KEY, type text NOT NULL, metadata jsonb,
      "hideMeta" boolean NOT NULL DEFAULT false
    );
  `);
});
afterAll(() => db.close());

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.afterRead = undefined;
  mocks.throwOnBlockedUserContent.mockResolvedValue(undefined);
  await db.exec(`DELETE FROM "Image";`);
  await insert(SONG, 'audio', stored);
  await insert(IMAGE, 'image', { width: 1, height: 1, title: 'kept' });
  await insert(VIDEO, 'video', { width: 1, height: 1 });

  dbMock.dbWrite.image.findUniqueOrThrow.mockImplementation((async ({
    where,
  }: {
    where: { id: number };
  }) => {
    const { rows } = await db.query<{ type: string; hideMeta: boolean; metadata: unknown }>(
      `SELECT type, "hideMeta", metadata FROM "Image" WHERE id = $1`,
      [where.id]
    );
    if (!rows[0]) throw new Error('not found');
    const hook = mocks.afterRead;
    mocks.afterRead = undefined;
    await hook?.();
    return { ...rows[0], ingestion: 'Scanned', blockedFor: null, nsfwLevel: 1, meta: null };
  }) as never);
  // Applies the columns these tests read, as Prisma would.
  dbMock.dbWrite.image.update.mockImplementation((async ({
    where,
    data,
  }: {
    where: { id: number };
    data: { hideMeta?: boolean; metadata?: object };
  }) => {
    if (data.hideMeta !== undefined)
      await db.query(`UPDATE "Image" SET "hideMeta" = $1 WHERE id = $2`, [data.hideMeta, where.id]);
    if (data.metadata !== undefined)
      await db.query(`UPDATE "Image" SET metadata = $1 WHERE id = $2`, [data.metadata, where.id]);
    return { id: where.id, url: 'u', userId: 5, name: null, type: 'audio' };
  }) as never);
  const INT4_OID = 23;
  dbMock.dbWrite.$executeRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = Prisma.sql(strings, ...values);
    const paramTypes = sql.values.map((v) => (Number.isInteger(v) ? INT4_OID : 0));
    return (await db.query(sql.text, sql.values, { paramTypes })).affectedRows ?? 0;
  }) as never);
});

/** Through the procedure's own input schema, as the router hands it over. */
const update = (input: Record<string, unknown>, id = SONG) =>
  updatePostImage(updatePostImageSchema.parse({ id, ...input }));

describe("updatePostImage — a song's title and remix setting", () => {
  it('stores the trimmed title in the song metadata, keeping its other fields', async () => {
    await update({ title: '  Night Drive  ' });

    expect(await storedMetadata()).toEqual({ ...stored, title: 'Night Drive' });
    // Not an Image column: Prisma rejects an update that names one.
    expect(dbMock.dbWrite.image.update.mock.calls[0][0].data).not.toHaveProperty('title');
  });

  it('clears the title when it is emptied', async () => {
    await update({ title: '   ' });

    expect(await storedMetadata()).toEqual({ duration: 120, bpm: 90 });
  });

  it('refuses a title longer than a post title', () => {
    expect(() => update({ title: 'x'.repeat(POST_TITLE_MAX_LENGTH + 1) })).toThrow();
  });

  it('refuses a title the blocked-content check rejects, writing nothing', async () => {
    mocks.throwOnBlockedUserContent.mockRejectedValue(new Error('blocked'));

    await expect(update({ title: 'bad words' })).rejects.toThrow('blocked');
    expect(mocks.throwOnBlockedUserContent).toHaveBeenCalledWith('bad words', expect.anything());
    expect(dbMock.dbWrite.image.update).not.toHaveBeenCalled();
    expect(await storedMetadata()).toEqual(stored);
  });

  it('stores allowRemix: false in the song metadata', async () => {
    await update({ allowRemix: false });

    expect(await storedMetadata()).toEqual({ ...stored, allowRemix: false });
    expect(dbMock.dbWrite.image.update.mock.calls[0][0].data).not.toHaveProperty('allowRemix');
  });

  it.each([
    ['image', IMAGE],
    ['video', VIDEO],
  ])('refuses a title or remix setting on an %s', async (_, id) => {
    const before = await storedMetadata(id);

    await expect(update({ title: 'x' }, id)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(update({ allowRemix: false }, id)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(dbMock.dbWrite.image.update).not.toHaveBeenCalled();
    expect(await storedMetadata(id)).toEqual(before);
  });

  it('updates an image as before when neither field is sent', async () => {
    await update({ hideMeta: true }, IMAGE);

    expect(await storedRow(IMAGE)).toEqual({
      metadata: { width: 1, height: 1, title: 'kept' },
      hideMeta: true,
    });
    expect(mocks.throwOnBlockedUserContent).not.toHaveBeenCalled();
  });

  it('never writes metadata carried in the input, even past the input schema', async () => {
    await updatePostImage({
      id: IMAGE,
      hideMeta: true,
      metadata: { blockProvenance: { forged: true } },
    } as never);

    expect(await storedRow(IMAGE)).toEqual({
      metadata: { width: 1, height: 1, title: 'kept' },
      hideMeta: true,
    });
  });
});

describe('updatePostImage — overlapping saves on one song', () => {
  it('keeps a remix setting saved while a title save waits on its content check', async () => {
    mocks.throwOnBlockedUserContent.mockImplementationOnce(async () => {
      await update({ allowRemix: false });
    });

    await update({ title: 'Night Drive' });

    expect(await storedMetadata()).toEqual({
      ...stored,
      title: 'Night Drive',
      allowRemix: false,
    });
  });

  it('keeps a cover linked between a title save reading the row and writing it', async () => {
    mocks.afterRead = () => linkCover(42);

    await update({ title: 'Night Drive' });

    expect(await storedMetadata()).toEqual({ ...stored, title: 'Night Drive', coverImageId: 42 });
  });

  it('keeps a title cleared and a cover linked while a remix save is in flight', async () => {
    mocks.afterRead = async () => {
      await linkCover(43);
      await update({ title: '' });
    };

    await update({ allowRemix: true });

    expect(await storedMetadata()).toEqual({
      duration: 120,
      bpm: 90,
      allowRemix: true,
      coverImageId: 43,
    });
  });

  it('keeps a title and cover written while a hide-prompt toggle is in flight', async () => {
    mocks.afterRead = async () => {
      await linkCover(44);
      await update({ title: 'Night Drive' });
    };

    await update({ hideMeta: true });

    expect(await storedRow(SONG)).toEqual({
      metadata: { ...stored, title: 'Night Drive', coverImageId: 44 },
      hideMeta: true,
    });
  });
});
