import { PGlite } from '@electric-sql/pglite';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/**
 * A bounty's share card shows only an image a signed-out visitor is served on the bounty page.
 * Image rows live in an in-process Postgres; a Prisma `imageConnection.findFirst` is answered
 * from the same rows by matching its `where`.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

// The card fetches its cover over HTTP; the URLs it asks for name the image it picked.
const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
vi.stubGlobal('fetch', fetchMock);

import handler from '~/pages/api/og';

// bounty id → its only image
const BLOCKED_FOR = 1;
const UNRATED = 2;
const CLEAN = 3;
const rows = [
  { id: 11, bountyId: BLOCKED_FOR, url: 'img-blocked', nsfwLevel: 1, blockedFor: 'tos' },
  { id: 12, bountyId: UNRATED, url: 'img-unrated', nsfwLevel: 0, blockedFor: null },
  { id: 13, bountyId: CLEAN, url: 'img-clean', nsfwLevel: 1, blockedFor: null },
].map((r) => ({
  ...r,
  userId: 5,
  type: 'image',
  width: 10,
  height: 10,
  ingestion: 'Scanned',
  needsReview: null,
  tosViolation: false,
  minor: false,
  modelRestricted: false,
}));

function matches(where: Record<string, unknown>, row: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) =>
    cond !== null && typeof cond === 'object'
      ? matches(cond as never, row[key] as never)
      : row[key] === cond
  );
}

beforeAll(async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int, url text, type text, width int, height int,
      "nsfwLevel" int, ingestion "ImageIngestionStatus", "needsReview" text, "blockedFor" text,
      "tosViolation" boolean, minor boolean, "modelRestricted" boolean NOT NULL
    );
    CREATE TABLE "ImageConnection" ("imageId" int, "entityId" int, "entityType" text);
  `);
  for (const r of rows) {
    await db.query(
      'INSERT INTO "Image" VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)',
      [
        r.id,
        r.userId,
        r.url,
        r.type,
        r.width,
        r.height,
        r.nsfwLevel,
        r.ingestion,
        r.needsReview,
        r.blockedFor,
        r.tosViolation,
        r.minor,
        r.modelRestricted,
      ]
    );
    await db.query('INSERT INTO "ImageConnection" VALUES ($1, $2, $3)', [
      r.id,
      r.bountyId,
      'Bounty',
    ]);
  }
  const raw = pgliteRaw(db);
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(raw.queryRaw);
  (
    dbMock.dbRead.imageConnection.findFirst as unknown as ReturnType<typeof vi.fn>
  ).mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    const row = rows.find((r) =>
      matches(where, { entityType: 'Bounty', entityId: r.bountyId, image: r } as never)
    );
    return row ? { image: row } : null;
  });
});

beforeEach(() => {
  fetchMock.mockClear();
  dbMock.dbRead.bounty.findFirst.mockResolvedValue({
    name: 'B',
    description: '',
    user: { username: 'u' },
  });
  dbMock.dbRead.bountyMetric.findFirst.mockResolvedValue(null);
});

const cardImage = async (bountyId: number) => {
  const res = {
    status: vi.fn(() => res),
    setHeader: vi.fn(() => res),
    send: vi.fn(() => res),
    json: vi.fn(() => res),
    end: vi.fn(() => res),
  } as unknown as NextApiResponse;
  await handler(
    {
      method: 'GET',
      query: { type: 'bounty', id: String(bountyId) },
      headers: {},
    } as unknown as NextApiRequest,
    res
  );
  const asked = fetchMock.mock.calls.map(([url]) => String(url));
  return ['img-blocked', 'img-unrated', 'img-clean'].filter((u) =>
    asked.some((a) => a.includes(u))
  );
};

describe('/api/og?type=bounty image', () => {
  it('shows a scanned, rated, unblocked image (control)', async () => {
    expect(await cardImage(CLEAN)).toEqual(['img-clean']);
  });

  it.each([
    ['carries a block reason', BLOCKED_FOR],
    ['is unrated', UNRATED],
  ])('shows no image that %s', async (_, bountyId) => {
    expect(await cardImage(bountyId)).toEqual([]);
  });
});
