import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as HotReads3 from '@civitai/db-queries/hot-reads-3';
import type * as FliptClient from '~/server/flipt/client';
import type * as SubscriptionsService from '~/server/services/subscriptions.service';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { REMIX_GALLERY_MAX_PENDING_PER_OWNER } from '~/shared/utils/remix-gallery';
import { dbMock } from '~/__tests__/mocks/db.mock';

// The Kysely/Prisma switch. FLIPT_FEATURE_FLAGS stays real, so the key asserted below is the one
// production evaluates.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
// Every hot-read-3 statement stubbed: their rows against Prisma's are compared in
// hot-reads-3.kysely-parity.test.ts.
vi.mock('@civitai/db-queries/hot-reads-3', async (importOriginal) => {
  const actual = await importOriginal<typeof HotReads3>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn()]));
});
vi.mock('~/server/services/subscriptions.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SubscriptionsService>()),
  getCapTier: async () => null,
}));
// Stubbed rather than spread, as in remix-gallery-visibility-owner.test.ts: each pulls the buzz
// service and its import graph, and nothing here reaches them.
vi.mock('~/server/services/placement-escrow.service', () => ({
  holdPlacementEscrow: vi.fn(),
  settlePlacement: vi.fn(),
  FEE_WAIVING_ACTIONS: [],
}));
vi.mock('~/server/services/placement-moderation.service', () => ({ assertCanPlace: vi.fn() }));
vi.mock('~/server/rewards/active/remixAccept.reward', () => ({
  remixAcceptReward: { apply: vi.fn() },
}));
vi.mock('~/server/services/free-placement.service', () => ({
  createFreePlacement: vi.fn(),
  getFreePlacementAllowance: vi.fn(),
  hasUsedFreePlacementOn: vi.fn(),
}));

const queries = await import('@civitai/db-queries/hot-reads-3');
const { kyselyRead, kyselyWrite } = await import('~/server/db/kyselyDb');
const { isFlipt } = await import('~/server/flipt/client');
const { getRemixGalleryVisibility } = await import('~/server/services/remix-gallery.service');

/**
 * The viewer's own pending submissions on a remix gallery (`getViewerPendingSubmissions`, reached
 * through `getRemixGalleryVisibility` for a signed-in viewer who is not the owner) behind
 * `kysely-hot-reads-3`. ON reads through Kysely on the replica only; OFF through Prisma only. Row
 * parity is in hot-reads-3.kysely-parity.test.ts.
 */

const flag = vi.mocked(isFlipt);
const q = vi.mocked(queries);
const kyselyReads = () => Object.values(q).filter((fn) => vi.isMockFunction(fn));

// Pairwise distinct.
const OWNER = 5101;
const VIEWER = 5202;
const HOST_IMAGE = 5303;
const SUBMITTED_IMAGE = 5404;
const PLACEMENT = 5505;
const CREATED = new Date('2026-09-03T04:05:06.789Z');
const EXPIRES = new Date('2026-09-05T04:05:06.789Z');

const pendingRow = {
  id: PLACEMENT,
  amount: 37,
  free: false,
  data: { imageId: SUBMITTED_IMAGE },
  createdAt: CREATED,
  expiresAt: EXPIRES,
};

const ON_KEYS = new Set(['kysely-hot-reads-3']);

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of kyselyReads()) fn.mockReset();
  flag.mockReset().mockResolvedValue(false);
  dbMock.dbWrite.placementSpace.findMany.mockResolvedValue([]);
  dbMock.dbWrite.image.findUnique.mockResolvedValue({
    id: HOST_IMAGE,
    userId: OWNER,
    postId: null,
    user: { username: 'host-owner' },
  });
  // One row answering every raw read on this path: the creator score, the has-entries probe, the
  // host image and the submitted images.
  dbMock.dbRead.$queryRaw.mockResolvedValue([
    { score: 0, exists: false, count: 0, nsfwLevel: 1, minor: false, showable: true },
  ]);
  dbMock.dbRead.placement.findMany.mockResolvedValue([pendingRow]);
  q.listViewerPendingRemixPlacements.mockResolvedValue([pendingRow] as never);
});

const visibility = () =>
  getRemixGalleryVisibility({
    hostImageId: HOST_IMAGE,
    browsingLevel: allBrowsingLevelsFlag,
    viewerId: VIEWER,
    domainLevels: allBrowsingLevelsFlag,
  });

const pendingInput = {
  surface: 'remixGallery',
  targetType: 'image',
  targetId: HOST_IMAGE,
  placerId: VIEWER,
  limit: REMIX_GALLERY_MAX_PENDING_PER_OWNER,
};

describe('getViewerPendingSubmissions behind kysely-hot-reads-3', () => {
  it('control: the routing checks below can tell the two Kysely clients apart', () => {
    expect(kyselyRead).not.toBe(kyselyWrite);
  });

  it('OFF: reads through Prisma only', async () => {
    const result = await visibility();
    expect(dbMock.dbRead.placement.findMany).toHaveBeenCalledWith({
      where: {
        surface: 'remixGallery',
        targetType: 'image',
        targetId: HOST_IMAGE,
        placerId: VIEWER,
        status: 'pending',
      },
      select: { id: true, amount: true, free: true, data: true, createdAt: true, expiresAt: true },
      orderBy: { createdAt: 'asc' },
      take: REMIX_GALLERY_MAX_PENDING_PER_OWNER,
    });
    for (const read of kyselyReads()) expect(read).not.toHaveBeenCalled();
    expect(result.viewerPending).toMatchObject([
      { placementId: PLACEMENT, amount: 37, free: false, createdAt: CREATED, expiresAt: EXPIRES },
    ]);
  });

  it('ON: the same rows through Kysely only, on the replica, with the same answer', async () => {
    const off = await visibility();
    vi.clearAllMocks();
    flag.mockImplementation(async (key) => ON_KEYS.has(key as string));
    const on = await visibility();
    expect(q.listViewerPendingRemixPlacements.mock.calls).toEqual([[kyselyRead, pendingInput]]);
    // By identity: `toEqual` compares the two Kysely clients structurally and cannot tell the
    // replica from the primary.
    expect(q.listViewerPendingRemixPlacements.mock.calls[0][0]).toBe(kyselyRead);
    expect(dbMock.dbRead.placement.findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ placerId: VIEWER }) })
    );
    expect(on.viewerPending).toStrictEqual(off.viewerPending);
  });

  it('evaluates kysely-hot-reads-3 by key, with no entity or context', async () => {
    await visibility();
    expect(flag.mock.calls.filter(([key]) => key === 'kysely-hot-reads-3')).toEqual([
      ['kysely-hot-reads-3'],
    ]);
  });
});
