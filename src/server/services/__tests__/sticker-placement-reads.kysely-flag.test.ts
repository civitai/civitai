import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as PlacementQueries from '@civitai/db-queries/placement';
import type * as Caches from '~/server/redis/caches';

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
// SQL pinned in packages/civitai-db-queries/src/placement.db.test.ts; rows against Prisma's in
// placement-reads.kysely-parity.test.ts.
vi.mock('@civitai/db-queries/placement', async (importOriginal) => {
  const actual = await importOriginal<typeof PlacementQueries>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn()]));
});
// No sticker on these rows is flagged, so nothing is kept off and no image is read.
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  cosmeticCache: { fetch: vi.fn(async () => ({})) },
}));

import { listApprovedPlacementRows, listStickerPlacementRows } from '@civitai/db-queries/placement';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import { kyselyRead, kyselyWrite } from '~/server/db/kyselyDb';
import { isFlipt } from '~/server/flipt/client';
import {
  getStickerPlacementCounts,
  getStickerPlacements,
  getStickerPlacementsAndCounts,
} from '~/server/services/sticker-placement.service';

const flag = vi.mocked(isFlipt);
const kyselyListing = vi.mocked(listStickerPlacementRows);
const kyselyApproved = vi.mocked(listApprovedPlacementRows);
const prismaFindMany = dbMock.dbRead.placement.findMany;

const IMAGE = 8101;
const OTHER_IMAGE = 8202;
const VIEWER = 8303;
const OWNER = 8404;

const row = (
  id: number,
  { targetId = IMAGE, status = 'approved', placerId = 8505, free = false, comment = '' } = {}
) => ({
  id,
  targetId,
  placerId,
  ownerId: OWNER,
  status,
  amount: free ? 0 : 300 + id,
  free,
  data: { cosmeticId: 9000 + id, x: 0.25, y: 0.75, scale: 0.2, rotation: 15, comment },
  createdAt: new Date(Date.UTC(2026, 9, 1, 0, id)),
});

// Approved rows on two images, a free one, a commented one, and the viewer's own pending row.
const LISTING_ROWS = [
  row(1),
  row(2, { targetId: OTHER_IMAGE, free: true }),
  row(3, { comment: 'nice' }),
  row(4, { status: 'pending', placerId: VIEWER }),
];
const APPROVED_ROWS = LISTING_ROWS.filter((r) => r.status === 'approved').map(
  ({ id, targetId, status, data }) => ({ id, targetId, status, data })
);

beforeEach(() => {
  resetSharedMocks();
  kyselyListing.mockReset().mockResolvedValue(LISTING_ROWS as never);
  kyselyApproved.mockReset().mockResolvedValue(APPROVED_ROWS as never);
  prismaFindMany.mockImplementation(async (args: { select: Record<string, boolean> }) =>
    args.select.placerId ? LISTING_ROWS : APPROVED_ROWS
  );
  flag.mockReset().mockResolvedValue(false);
});

describe('sticker listing reads under kysely-placement-reads', () => {
  const args = { imageIds: [IMAGE, OTHER_IMAGE], viewerId: VIEWER };

  it('OFF: lists and counts through Prisma only', async () => {
    const result = await getStickerPlacementsAndCounts(args);
    // Positive control: the rows reach the listing, so ON vs OFF is not two empty answers.
    expect(result.placements.map((p) => p.id)).toEqual([1, 2, 3, 4]);
    expect(result.counts).toEqual({ [IMAGE]: 2, [OTHER_IMAGE]: 1 });
    expect(prismaFindMany).toHaveBeenCalledTimes(1);
    expect(kyselyListing).not.toHaveBeenCalled();
  });

  it('ON: the listing and counts are the same, read through Kysely on the replica', async () => {
    const off = await getStickerPlacementsAndCounts(args);
    prismaFindMany.mockClear();
    flag.mockResolvedValue(true);

    await expect(getStickerPlacementsAndCounts(args)).resolves.toEqual(off);
    expect(prismaFindMany).not.toHaveBeenCalled();
    expect(kyselyListing).toHaveBeenCalledTimes(1);
    expect(kyselyListing.mock.calls[0][0]).toBe(kyselyRead);
    expect(kyselyRead).not.toBe(kyselyWrite);
    expect(kyselyListing.mock.calls[0][1]).toEqual({
      surface: 'sticker',
      targetType: 'image',
      targetIds: [IMAGE, OTHER_IMAGE],
      viewerId: VIEWER,
    });
  });

  it('ON: the legacy listing is the same, through the same read', async () => {
    const off = await getStickerPlacements(args);
    flag.mockResolvedValue(true);
    await expect(getStickerPlacements(args)).resolves.toEqual(off);
    expect(kyselyListing.mock.calls[0][1]).toMatchObject({ viewerId: VIEWER });
  });

  it('ON: a signed-out viewer passes no viewer id', async () => {
    flag.mockResolvedValue(true);
    await getStickerPlacements({ imageIds: [IMAGE] });
    expect(kyselyListing.mock.calls[0][1]).toEqual({
      surface: 'sticker',
      targetType: 'image',
      targetIds: [IMAGE],
      viewerId: undefined,
    });
  });

  it('ON: the per-image counts are the same, from the approved rows on the replica', async () => {
    const off = await getStickerPlacementCounts([IMAGE, OTHER_IMAGE]);
    expect(off).toEqual({ [IMAGE]: 2, [OTHER_IMAGE]: 1 });
    prismaFindMany.mockClear();
    flag.mockResolvedValue(true);

    await expect(getStickerPlacementCounts([IMAGE, OTHER_IMAGE])).resolves.toEqual(off);
    expect(prismaFindMany).not.toHaveBeenCalled();
    expect(kyselyApproved.mock.calls[0][0]).toBe(kyselyRead);
    expect(kyselyApproved.mock.calls[0][1]).toEqual({
      surface: 'sticker',
      targetType: 'image',
      targetIds: [IMAGE, OTHER_IMAGE],
    });
  });
});
