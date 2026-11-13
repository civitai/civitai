import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `getFallbackCoverImages` picks, per collection, the newest ACCEPTED item a block may be
 * served. Its rule is written in SQL, so it runs here against a Postgres stand-in with one
 * fixture item per refused state; each refused item is the NEWEST in its collection, so a
 * clause that stops refusing it changes which cover comes back.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (src: string) => src }));
vi.mock('~/server/auth/session-client', () => ({ sessionClient: {} }));

import {
  getFallbackCoverImages,
  getModelRestrictedImageIds,
} from '~/server/services/blocks/block-collections.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

/** SFW ceiling: PG (1) | PG13 (2). */
const SFW = 3;

/** Clean scanned PG image; each refused fixture changes exactly one column. */
const CLEAN = {
  nsfwLevel: 1,
  ingestion: 'Scanned',
  needsReview: null,
  poi: false,
  minor: false,
  acceptableMinor: false,
  tosViolation: false,
  blockedFor: null,
} as const;

const REFUSED = {
  poi: { poi: true },
  minor: { minor: true },
  needsReview: { needsReview: 'poi' },
  acceptableMinor: { acceptableMinor: true },
  tosViolation: { tosViolation: true },
  blockedFor: { blockedFor: 'moderated' },
  unscanned: { ingestion: 'Pending' },
  scanBlocked: { ingestion: 'Blocked' },
  scanNotFound: { ingestion: 'NotFound' },
  rescanning: { ingestion: 'Rescan' },
  unrated: { nsfwLevel: 0 },
  aboveCeiling: { nsfwLevel: 8 },
  unpublishedPost: { post: { publishedAt: null } },
  scheduledPost: { post: { publishedAt: '2999-01-01' } },
  privatePost: { post: { availability: 'Private' } },
  noPost: { post: null },
} as const;

/** A ceiling that admits mature levels: PG | PG13 | R | X | XXX. */
const ALL_LEVELS = 31;

type Row = typeof CLEAN | Record<string, unknown>;
const lit = (v: unknown) =>
  v === null ? 'NULL' : typeof v === 'string' ? `'${v}'` : String(v as number | boolean);

/** Each image gets its own published public post unless `post` overrides it (null: no post). */
async function insertImage(id: number, row: Row) {
  const { post, ...image } = row as Record<string, unknown> & {
    post?: Record<string, unknown> | null;
  };
  const r = { ...CLEAN, ...image } as Record<string, unknown>;
  if (post !== null) {
    const p = { publishedAt: '2026-01-01', availability: 'Public', ...post };
    await holder.db.exec(`
      INSERT INTO "Post" (id, "publishedAt", availability)
      VALUES (${id}, ${lit(p.publishedAt)}, ${lit(p.availability)});
    `);
  }
  await holder.db.exec(`
    INSERT INTO "Image" (id, url, type, "postId", "nsfwLevel", ingestion, "needsReview", poi, minor,
      "acceptableMinor", "tosViolation", "blockedFor", "modelRestricted")
    VALUES (${id}, 'img-${id}', 'image', ${post === null ? 'NULL' : id}, ${lit(r.nsfwLevel)}, ${lit(
    r.ingestion
  )},
      ${lit(r.needsReview)}, ${lit(r.poi)}, ${lit(r.minor)}, ${lit(r.acceptableMinor)},
      ${lit(r.tosViolation)}, ${lit(r.blockedFor)}, ${lit(
    r.modelRestricted === undefined ? false : r.modelRestricted
  )});
  `);
}

async function insertItem(
  collectionId: number,
  imageId: number,
  createdAt: string,
  status = 'ACCEPTED'
) {
  await holder.db.exec(`
    INSERT INTO "CollectionItem" ("collectionId", "imageId", status, "createdAt")
    VALUES (${collectionId}, ${imageId}, '${status}', '${createdAt}');
  `);
}

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
    CREATE TYPE "CollectionItemStatus" AS ENUM ('ACCEPTED', 'REVIEW', 'REJECTED');
    CREATE TYPE "MediaType" AS ENUM ('image', 'video', 'audio');
    CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
    CREATE TABLE "Post" (
      id int PRIMARY KEY,
      "publishedAt" timestamp(3),
      availability "Availability" NOT NULL DEFAULT 'Public'
    );
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      url text NOT NULL,
      type "MediaType" NOT NULL DEFAULT 'image',
      "postId" int,
      "nsfwLevel" int NOT NULL DEFAULT 0,
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Pending',
      "needsReview" text,
      poi boolean NOT NULL DEFAULT false,
      minor boolean NOT NULL DEFAULT false,
      "acceptableMinor" boolean NOT NULL DEFAULT false,
      "tosViolation" boolean NOT NULL DEFAULT false,
      "blockedFor" text,
      "modelRestricted" boolean DEFAULT false
    );
    CREATE TABLE "CollectionItem" (
      id serial PRIMARY KEY,
      "collectionId" int NOT NULL,
      "imageId" int,
      status "CollectionItemStatus" NOT NULL,
      "createdAt" timestamp(3) NOT NULL
    );
  `);
});

beforeEach(async () => {
  vi.mocked(dbMock.dbRead.$queryRaw).mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = Prisma.sql(strings, ...(values as never[]));
    return (await holder.db.query(sql.text, sql.values as unknown[])).rows;
  }) as never);
  await holder.db.exec(`TRUNCATE "Image", "CollectionItem", "Post";`);
});

describe('getFallbackCoverImages against Postgres', () => {
  it('picks each collection its own newest clean item, and omits a collection with none', async () => {
    // Collection 10: newest is refused, so the older clean one. Collection 20: its own
    // newest, even though 10's items are newer. Collection 30: only refused items.
    // Collection 40: no items at all.
    await insertImage(1, {});
    await insertImage(2, { poi: true });
    await insertImage(3, {});
    await insertImage(4, {});
    await insertImage(5, { minor: true });
    await insertItem(10, 1, '2026-02-01');
    await insertItem(10, 2, '2026-02-05');
    await insertItem(20, 3, '2026-01-01');
    await insertItem(20, 4, '2026-01-02');
    await insertItem(30, 5, '2026-03-01');
    const map = await getFallbackCoverImages([10, 20, 30, 40], SFW);
    expect([...map.entries()].sort(([a], [b]) => a - b)).toEqual([
      [10, { url: 'img-1', type: 'image', nsfwLevel: 1 }],
      [20, { url: 'img-4', type: 'image', nsfwLevel: 1 }],
    ]);
  });

  it('serves the newest clean accepted item', async () => {
    await insertImage(1, {});
    await insertImage(2, {});
    await insertItem(10, 1, '2026-01-01');
    await insertItem(10, 2, '2026-01-02');
    const map = await getFallbackCoverImages([10], SFW);
    expect(map.get(10)).toEqual({ url: 'img-2', type: 'image', nsfwLevel: 1 });
  });

  it('skips a REVIEW item even when it is the newest', async () => {
    await insertImage(1, {});
    await insertImage(2, {});
    await insertItem(10, 1, '2026-01-01');
    await insertItem(10, 2, '2026-01-02', 'REVIEW');
    expect((await getFallbackCoverImages([10], SFW)).get(10)?.url).toBe('img-1');
  });

  it.each(Object.entries(REFUSED))(
    'skips a newest item that is %s and serves the older clean one',
    async (_state, over) => {
      await insertImage(1, {});
      await insertImage(2, over);
      await insertItem(10, 1, '2026-01-01');
      await insertItem(10, 2, '2026-01-02');
      expect((await getFallbackCoverImages([10], SFW)).get(10)?.url).toBe('img-1');
    }
  );

  it('returns no cover for a collection whose only items are all refused', async () => {
    const states = Object.values(REFUSED);
    for (let i = 0; i < states.length; i++) {
      await insertImage(100 + i, states[i]);
      await insertItem(10, 100 + i, `2026-01-${String(i + 1).padStart(2, '0')}`);
    }
    const map = await getFallbackCoverImages([10], SFW);
    expect(map.has(10)).toBe(false);
    expect(map.size).toBe(0);
  });

  describe('restricted base model', () => {
    it('skips a newest mature item on a restricted base model at a mature ceiling', async () => {
      await insertImage(1, { nsfwLevel: 4 });
      await insertImage(2, { nsfwLevel: 4, modelRestricted: true });
      await insertItem(10, 1, '2026-01-01');
      await insertItem(10, 2, '2026-01-02');
      expect((await getFallbackCoverImages([10], ALL_LEVELS)).get(10)?.url).toBe('img-1');
    });

    it('keeps a newest SFW item on a restricted base model', async () => {
      await insertImage(1, {});
      await insertImage(2, { modelRestricted: true });
      await insertItem(10, 1, '2026-01-01');
      await insertItem(10, 2, '2026-01-02');
      expect((await getFallbackCoverImages([10], ALL_LEVELS)).get(10)?.url).toBe('img-2');
    });
  });
});

describe('getModelRestrictedImageIds against Postgres', () => {
  it('returns only the mature images on a restricted base model', async () => {
    await insertImage(1, { nsfwLevel: 4, modelRestricted: true });
    await insertImage(2, { nsfwLevel: 4 });
    await insertImage(3, { nsfwLevel: 1, modelRestricted: true });
    await insertImage(4, { nsfwLevel: 2, modelRestricted: true });
    expect([...(await getModelRestrictedImageIds([1, 2, 3, 4, 99]))]).toEqual([1]);
  });

  it('treats a NULL modelRestricted on a mature image as refused, as getAllImages does', async () => {
    await insertImage(1, { nsfwLevel: 4, modelRestricted: null });
    await insertImage(2, { nsfwLevel: 1, modelRestricted: null });
    expect([...(await getModelRestrictedImageIds([1, 2]))]).toEqual([1]);
  });

  it('runs no query for no ids', async () => {
    vi.mocked(dbMock.dbRead.$queryRaw).mockClear();
    expect((await getModelRestrictedImageIds([])).size).toBe(0);
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });
});
