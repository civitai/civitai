import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AppListingRating from '~/server/services/blocks/app-listing-rating';

const { ids } = vi.hoisted(() => ({ ids: { n: 0 } }));
vi.mock('~/server/services/blocks/app-listing-rating', async (importOriginal) => ({
  ...(await importOriginal<typeof AppListingRating>()),
  recordListingRatingChangeAfterCommit: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blocks/app-listing-notify', () => ({
  notifyAppListingOwner: vi.fn(async () => undefined),
}));
vi.mock('~/server/utils/app-block-ids', () => ({
  newAppListingModerationEventId: () => `alme_red_${++ids.n}`,
  newAppListingPublishRequestId: () => `alpr_red_${++ids.n}`,
  newAppListingReportId: () => `alrp_red_${++ids.n}`,
  newAppOwnershipEventId: () => `aoe_red_${++ids.n}`,
  newUlid: () => `ULIDRED${++ids.n}`,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';
import { NsfwLevel } from '~/server/common/enums';
import {
  republishOwnListing,
  unpublishOwnListing,
} from '~/server/services/blocks/offsite-moderation.service';
import { createSplitDb, type SplitDb } from './listing-media-split.harness';

/**
 * T11 — the owner unpublish → republish asset gate sees the civitai.red icon / cover overrides.
 * An owner may edit a `removed` listing's overrides directly; the approved-asset snapshot the
 * unpublish records (v2) must carry them, so a republish whose ONLY change is an override goes
 * back to review. The overrides are real SQL (PGlite, both real migrations); the listing rows,
 * screenshots and events are the shared Prisma mock.
 *
 * Ids: listing `apl_rp_live`, own icon 111 / cover 112 / screenshot 113, overrides 114 / 115,
 * owner 116 — pairwise distinct.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const LIVE = 'apl_rp_live';
const OWNER = 116;
const ICON = 111;
const COVER = 112;
const SHOT = 113;
const OVERRIDE_A = 114;
const OVERRIDE_B = 115;

let split: SplitDb;
beforeAll(async () => {
  split = await createSplitDb();
  await split.applyMigration();
  await split.applyRedSlotsMigration();
});
afterAll(() => split.db.close());

const mockWrite = dbMock.dbWrite;
let status: 'approved' | 'removed';
/** The `before` payload of the last `owner-unpublish` event the code wrote (or a seeded one). */
let recordedBefore: unknown;

beforeEach(async () => {
  vi.clearAllMocks();
  ids.n = 0;
  await split.db.exec(`TRUNCATE app_listing_red_media, app_listings, "Image", "User" CASCADE`);
  await split.seed({ listingIds: [LIVE] });
  await split.seedImages(
    [ICON, COVER, SHOT, OVERRIDE_A, OVERRIDE_B].map((id) => ({ id, nsfwLevel: NsfwLevel.PG }))
  );
  split.route(mockWrite as never);
  split.route(dbMock.dbRead as never);
  status = 'approved';
  recordedBefore = undefined;
  mockWrite.$transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb(mockWrite)
  );
  mockWrite.appListing.findUnique.mockImplementation(async () => ({
    userId: OWNER,
    status,
    kind: 'offsite',
    slug: 'red-republish',
    name: 'Red Republish',
    appBlockId: null,
    contentRating: 'g',
    iconId: ICON,
    coverId: COVER,
    externalUrl: 'https://cool.app',
    connectClientId: null,
  }));
  mockWrite.appListing.updateMany.mockImplementation(async (a: { data: { status: string } }) => {
    status = a.data.status as typeof status;
    return { count: 1 };
  });
  mockWrite.appListingScreenshot.findMany.mockResolvedValue([
    { imageId: SHOT, order: 0, caption: null },
  ]);
  mockWrite.image.findMany.mockImplementation(async (a: { where: { id: { in: number[] } } }) =>
    a.where.id.in.map((id) => ({ id, ingestion: 'Scanned', nsfwLevel: NsfwLevel.PG }))
  );
  mockWrite.appListingModerationEvent.create.mockImplementation(
    async (a: { data: { action: string; before: unknown } }) => {
      if (a.data.action === 'owner-unpublish') recordedBefore = a.data.before;
      return a.data;
    }
  );
  mockWrite.appListingModerationEvent.findFirst.mockImplementation(async () => ({
    action: 'owner-unpublish',
    before: recordedBefore,
  }));
  mockWrite.appListingPublishRequest.findFirst.mockResolvedValue(null);
  mockWrite.appListingPublishRequest.create.mockImplementation(
    async (a: { data: unknown }) => a.data
  );
});

const unpublish = () => unpublishOwnListing({ input: { appListingId: LIVE }, userId: OWNER });
const republish = () => republishOwnListing({ input: { appListingId: LIVE }, userId: OWNER });

describe('T11 — the republish gate and the civitai.red overrides', () => {
  it('🔴 the unpublish records the overrides in the approved-asset snapshot (v2)', async () => {
    await split.setRedSlots(LIVE, { icon: null, cover: OVERRIDE_A });
    await unpublish();
    expect(recordedBefore).toMatchObject({
      assets: { v: 2, iconId: ICON, coverId: COVER, redIconId: null, redCoverId: OVERRIDE_A },
    });
  });

  it('🔴 swapping ONLY an override while removed sends the republish back to review', async () => {
    await split.setRedSlots(LIVE, { icon: null, cover: OVERRIDE_A });
    await unpublish();
    await split.setRedSlots(LIVE, { icon: null, cover: OVERRIDE_B });
    expect(await republish()).toEqual({
      appListingId: LIVE,
      status: 'pending',
      reviewReason: 'assets-changed',
    });
  });

  it('🔴 adding an override where there was none sends it back to review', async () => {
    await unpublish();
    await split.setRedSlots(LIVE, { icon: OVERRIDE_A, cover: null });
    expect((await republish()).status).toBe('pending');
  });

  it('positive control: an untouched listing with overrides republishes immediately', async () => {
    await split.setRedSlots(LIVE, { icon: OVERRIDE_A, cover: OVERRIDE_B });
    await unpublish();
    expect(await republish()).toEqual({ appListingId: LIVE, status: 'approved' });
  });

  it('invariant guard: a listing unpublished before the overrides existed (v1) republishes immediately when it still has none', async () => {
    recordedBefore = {
      status: 'approved',
      assets: {
        v: 1,
        iconId: ICON,
        coverId: COVER,
        screenshots: [{ imageId: SHOT, caption: null }],
      },
    };
    status = 'removed';
    expect(await republish()).toEqual({ appListingId: LIVE, status: 'approved' });
  });

  it('🔴 …and goes to review once an override was added after that v1 unpublish', async () => {
    recordedBefore = {
      status: 'approved',
      assets: {
        v: 1,
        iconId: ICON,
        coverId: COVER,
        screenshots: [{ imageId: SHOT, caption: null }],
      },
    };
    status = 'removed';
    await split.setRedSlots(LIVE, { icon: OVERRIDE_A, cover: null });
    expect((await republish()).status).toBe('pending');
  });
});
