import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The main app's `/api/mod/held-media` runs the shared `heldImageSql` against real SQL here. The
 * fragment's full set of cases is pinned in the moderator app's `held-media-eligibility.pglite.test.ts`;
 * this pins that the main app runs it on the image it was asked for.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE "MediaType" AS ENUM ('image', 'video', 'audio');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, url text NOT NULL, type "MediaType" NOT NULL DEFAULT 'image',
      "mimeType" text, "needsReview" text, "blockedFor" text, "userId" int NOT NULL
    );
    CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, details jsonb);
    CREATE VIEW "EvidenceHeldUser" AS SELECT 0 AS "userId" WHERE false;
    INSERT INTO "Image" (id, url, type, "mimeType", "needsReview", "userId") VALUES
      (1, 'key-1', 'video', 'video/mp4', 'csam', 301),
      (2, 'key-2', 'image', NULL, NULL, 302),
      (3, 'key-3', 'image', NULL, NULL, 303),
      (4, 'key-4', 'image', NULL, NULL, 301);
    INSERT INTO "CsamReport" ("userId", details) VALUES (303, '{}');
  `);
});

beforeEach(() => {
  dbMock.dbRead.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...v: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(v as never[]));
    return (await pg.query(flat.text, flat.values as unknown[])).rows;
  }) as never);
});

const { getHeldMedia } = await import('~/server/services/held-media.service');

describe('getHeldMedia', () => {
  it('serves the image asked for when it is flagged or its owner is reported', async () => {
    expect(await getHeldMedia(1)).toEqual({ url: 'key-1', type: 'video', mimeType: 'video/mp4' });
    expect(await getHeldMedia(3)).toEqual({ url: 'key-3', type: 'image', mimeType: null });
  });

  it('refuses an ordinary image, another image of a flagged one’s owner, and a missing id', async () => {
    expect(await getHeldMedia(2)).toBeNull();
    expect(await getHeldMedia(4)).toBeNull();
    expect(await getHeldMedia(999)).toBeNull();
  });
});
