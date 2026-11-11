import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as HotReads5 from '@civitai/db-queries/hot-reads-5';
import type * as HotReads3 from '@civitai/db-queries/hot-reads-3';
import type * as FliptClient from '~/server/flipt/client';
import type * as SubscriptionsService from '~/server/services/subscriptions.service';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { REMIX_GALLERY_MAX_PENDING_PER_OWNER } from '~/shared/utils/remix-gallery';
import { dbMock } from '~/__tests__/mocks/db.mock';

// The Kysely placement reads this path makes. Their rows, against a real database, are pinned in
// placement-reads.kysely-parity.test.ts.
const placementReads = vi.hoisted(() => ({
  getImagePlacementTarget: vi.fn(),
  listPlacementSpacesFor: vi.fn(),
  countPlacements: vi.fn(),
  getUserPlacementScore: vi.fn(),
}));
vi.mock('@civitai/db-queries/placement', () => placementReads);
// `getPlacementConfig`'s KeyValue read, through Kysely: no stored row, so the compiled defaults
// apply.
const { placementConfigRow } = vi.hoisted(() => ({
  placementConfigRow: vi.fn(async () => undefined),
}));
vi.mock('@civitai/db-queries/hot-reads-5', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads5>()),
  getKeyValue: placementConfigRow,
}));
// Every server flag on this path reads off.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(async () => false),
}));
// Every hot-read-3 statement stubbed: their rows, against a real database, are pinned in
// hot-reads-3.kysely-parity.test.ts.
vi.mock('@civitai/db-queries/hot-reads-3', async (importOriginal) => {
  const actual = await importOriginal<typeof HotReads3>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn()]));
});
vi.mock('~/server/services/subscriptions.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SubscriptionsService>()),
  getCapTier: async () => null,
  getCapTierViaKysely: async () => null,
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

// The service loads its Kysely clients on first use; every raw read on this path (the host image,
// the hosts-with-entries lookup) answers from the fake below, and the pending read is stubbed above.
const kysely = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('~/server/db/kyselyDb.lazy', async () =>
  (await import('~/test-utils/kysely-raw-fake')).fakeKyselyDbLazy(kysely.read, kysely.write)
);
const ONE_ROW = [{ score: 0, exists: false, count: 0, nsfwLevel: 1, minor: false, showable: true }];

const queries = await import('@civitai/db-queries/hot-reads-3');
// The clients the service is handed, so the routing checks below compare like with like.
const { kyselyRead, kyselyWrite } = await (
  await import('~/server/db/kyselyDb.lazy')
).loadKyselyDb();
const { getRemixGalleryVisibility } = await import('~/server/services/remix-gallery.service');

/**
 * The viewer's own pending submissions on a remix gallery (`getViewerPendingSubmissions`, reached
 * through `getRemixGalleryVisibility` for a signed-in viewer who is not the owner): one Kysely read
 * on the replica. Its rows, against a real database, are pinned in
 * hot-reads-3.kysely-parity.test.ts.
 */

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

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of kyselyReads()) fn.mockReset();
  placementReads.listPlacementSpacesFor.mockResolvedValue([]);
  placementReads.countPlacements.mockResolvedValue(0);
  placementReads.getUserPlacementScore.mockResolvedValue([{ score: 0 }]);
  placementReads.getImagePlacementTarget.mockResolvedValue({
    id: HOST_IMAGE,
    userId: OWNER,
    postId: null,
    type: 'image',
    username: 'host-owner',
  });
  // One row answering every raw read on this path: the has-entries probe, the host image and the
  // submitted images.
  dbMock.dbRead.$queryRaw.mockResolvedValue(ONE_ROW);
  kysely.read
    .mockReset()
    .mockImplementation(async (strings: readonly string[]) =>
      strings.join('?').includes('SELECT DISTINCT pl."targetId" AS "hostId"') ? [] : ONE_ROW
    );
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

describe('getViewerPendingSubmissions', () => {
  it('control: the routing checks below can tell the two Kysely clients apart', () => {
    expect(kyselyRead).not.toBe(kyselyWrite);
  });

  it('reads the pending rows through Kysely only, on the replica', async () => {
    const result = await visibility();
    expect(q.listViewerPendingRemixPlacements.mock.calls).toEqual([[kyselyRead, pendingInput]]);
    // By identity: `toEqual` compares the two Kysely clients structurally and cannot tell the
    // replica from the primary.
    expect(q.listViewerPendingRemixPlacements.mock.calls[0][0]).toBe(kyselyRead);
    expect(dbMock.dbRead.placement.findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ placerId: VIEWER }) })
    );
    expect(result.viewerPending).toMatchObject([
      { placementId: PLACEMENT, amount: 37, free: false, createdAt: CREATED, expiresAt: EXPIRES },
    ]);
  });
});
