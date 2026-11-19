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
const fetchMock = vi.fn(async (_url: RequestInfo | URL) => new Response(null, { status: 404 }));
vi.stubGlobal('fetch', fetchMock);

import handler from '~/pages/api/og';

// bounty id → its images, in insert order
const BLOCKED_FOR = 1;
const UNRATED = 2;
const CLEAN = 3;
const TOS_VIOLATION = 4;
const BLOCKED_THEN_CLEAN = 5;
const rows = [
  { id: 11, bountyId: BLOCKED_FOR, url: 'img-blocked', blockedFor: 'tos' },
  { id: 12, bountyId: UNRATED, url: 'img-unrated', nsfwLevel: 0 },
  { id: 13, bountyId: CLEAN, url: 'img-clean' },
  { id: 14, bountyId: TOS_VIOLATION, url: 'img-tos', tosViolation: true },
  { id: 15, bountyId: BLOCKED_THEN_CLEAN, url: 'img-first-blocked', blockedFor: 'tos' },
  { id: 16, bountyId: BLOCKED_THEN_CLEAN, url: 'img-second-clean' },
].map((r) => ({
  userId: 5,
  type: 'image',
  width: 10,
  height: 10,
  nsfwLevel: 1,
  ingestion: 'Scanned',
  needsReview: null,
  blockedFor: null as string | null,
  tosViolation: false,
  minor: false,
  modelRestricted: false,
  ...r,
}));

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
  // A URL can name the image more than once.
  return [
    ...new Set(fetchMock.mock.calls.flatMap(([url]) => String(url).match(/img-[a-z-]+/g) ?? [])),
  ];
};

describe('/api/og?type=bounty image', () => {
  it('shows a scanned, rated, unblocked image (control)', async () => {
    expect(await cardImage(CLEAN)).toEqual(['img-clean']);
  });

  it.each([
    ['carries a block reason', BLOCKED_FOR],
    ['is unrated', UNRATED],
    ['violates the ToS', TOS_VIOLATION],
  ])('shows no image that %s', async (_, bountyId) => {
    expect(await cardImage(bountyId)).toEqual([]);
  });

  it('passes over a blocked image to a servable one on the same bounty', async () => {
    expect(await cardImage(BLOCKED_THEN_CLEAN)).toEqual(['img-second-clean']);
  });
});
