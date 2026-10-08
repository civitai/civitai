import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Runs the real statement against a Postgres stand-in: a $queryRaw fake returning a fixture row
// would pass whatever the WHERE clause filters on.

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

import { getCachedImageDeliveryMetadata } from '~/server/services/image-delivery.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

const STATES = Object.values(ImageIngestionStatus);

const urlFor = (state: string, hideMeta: boolean) =>
  `${state.toLowerCase()}-${hideMeta ? 'hidden' : 'shown'}/img.jpeg`;

const runAgainstPglite = async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const flat = Prisma.sql(strings, ...(values as never[]));
  return (await holder.db.query(flat.text, flat.values as unknown[])).rows;
};

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM (${STATES.map((s) => `'${s}'`).join(', ')});
    CREATE TYPE "MediaType" AS ENUM ('image', 'video', 'audio');
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      url text NOT NULL,
      "hideMeta" boolean NOT NULL DEFAULT false,
      type "MediaType" NOT NULL DEFAULT 'image',
      "mimeType" text,
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Pending'
    );
  `);

  const rows = STATES.flatMap((state, i) => [
    `(${100 + i}, '${urlFor(state, false)}', false, '${state}')`,
    `(${200 + i}, '${urlFor(state, true)}', true, '${state}')`,
  ]);
  await holder.db.exec(`
    INSERT INTO "Image" (id, url, "hideMeta", ingestion) VALUES ${rows.join(',\n')};
  `);
});

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.redis.packed.get.mockResolvedValue(null);
  redisMock.redis.packed.set.mockResolvedValue(undefined);
  vi.mocked(dbMock.dbRead.$queryRaw).mockImplementation(runAgainstPglite as never);
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(runAgainstPglite as never);
});

describe('image delivery lookup — source known missing', () => {
  it('returns no row for a NotFound image whose metadata is not hidden', async () => {
    expect(
      await getCachedImageDeliveryMetadata(urlFor(ImageIngestionStatus.NotFound, false))
    ).toBeNull();
  });

  it('applies the same filter on the primary fallback when the replica query fails', async () => {
    vi.mocked(dbMock.dbRead.$queryRaw).mockRejectedValueOnce(new Error('replica error'));

    expect(
      await getCachedImageDeliveryMetadata(urlFor(ImageIngestionStatus.NotFound, false))
    ).toBeNull();
    expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalledTimes(1);
  });

  // Invariant guard (passes before and after): hideMeta rows are still returned when NotFound.
  it('still returns a NotFound image whose metadata is hidden', async () => {
    expect(
      await getCachedImageDeliveryMetadata(urlFor(ImageIngestionStatus.NotFound, true))
    ).toEqual({
      id: 200 + STATES.indexOf(ImageIngestionStatus.NotFound),
      url: urlFor(ImageIngestionStatus.NotFound, true),
      hideMeta: true,
      type: 'image',
      mimeType: null,
    });
  });

  // Invariant guard: every other ingestion state is unaffected, hidden or not.
  it.each(
    STATES.filter((s) => s !== ImageIngestionStatus.NotFound).flatMap((s) => [
      [s, false] as const,
      [s, true] as const,
    ])
  )('still returns a %s image (hideMeta=%s)', async (state, hideMeta) => {
    const result = await getCachedImageDeliveryMetadata(urlFor(state, hideMeta));
    expect(result).toEqual({
      id: (hideMeta ? 200 : 100) + STATES.indexOf(state),
      url: urlFor(state, hideMeta),
      hideMeta,
      type: 'image',
      mimeType: null,
    });
  });
});
