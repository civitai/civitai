import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AppListingRating from '~/server/services/blocks/app-listing-rating';

const { recordRatingChange } = vi.hoisted(() => ({
  recordRatingChange: vi.fn(async (..._a: unknown[]): Promise<void> => undefined),
}));
vi.mock('~/server/services/blocks/app-listing-rating', async (importOriginal) => ({
  ...(await importOriginal<typeof AppListingRating>()),
  recordListingRatingChangeAfterCommit: (...a: unknown[]) => recordRatingChange(...a),
}));
vi.mock('~/server/services/blocks/app-listing-notify', () => ({
  notifyAppListingOwner: vi.fn(async () => undefined),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import { approveExternalRequest } from '~/server/services/blocks/offsite-listing.service';
import type { ListingMediaSplitDecision } from '~/shared/utils/listing-media-split';
import { createSplitDb, type SplitDb } from './listing-media-split.harness';

/**
 * Every moderator go-live `approveExternalRequest` reaches, with a civitai.red icon override set
 * on the listing going live: the override floors the rating unless a moderator splits the
 * listing; it is held to the go-live scan gate like the listing's own media; and a revision's
 * overrides reach the live listing. The overrides and the split are real SQL (PGlite, both real
 * migrations); the listing rows are the shared Prisma mock.
 *
 * Fixture: a `g` app whose icon, cover and screenshot are all PG, so ONLY the override can move
 * the rating — ids 51 (icon) / 52 (cover) / 53 (screenshot) / 54 (R override) / 55 (Blocked
 * override) / 56 (still-scanning override) / 57 (PG-13 override), distinct from every constant.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const MOD = 8;
const OWNER = 43;
const REQUEST_ID = 'alpr_red';
const LISTING_ID = 'apl_red_go';
const PARENT_ID = 'apl_red_go_parent';
const SHADOW_ID = 'apl_red_go_shadow';
const ICON = 51;
const COVER = 52;
const SHOT = 53;
const R_OVERRIDE = 54;
const BLOCKED_OVERRIDE = 55;
const SCANNING_OVERRIDE = 56;
const PG13_OVERRIDE = 57;

const LEVELS: Record<number, number> = {
  [ICON]: NsfwLevel.PG,
  [COVER]: NsfwLevel.PG,
  [SHOT]: NsfwLevel.PG,
  [R_OVERRIDE]: NsfwLevel.R,
  [BLOCKED_OVERRIDE]: NsfwLevel.R,
  [SCANNING_OVERRIDE]: 0,
  [PG13_OVERRIDE]: NsfwLevel.PG13,
};
const INGESTION: Record<number, string> = {
  [BLOCKED_OVERRIDE]: 'Blocked',
  [SCANNING_OVERRIDE]: 'Pending',
};

const mockRead = dbMock.dbRead;
const mockWrite = dbMock.dbWrite;

let split: SplitDb;
beforeAll(async () => {
  split = await createSplitDb();
});
afterAll(() => split.db.close());

async function resetTables(redSlots: boolean) {
  await split.db.exec(`DROP TABLE IF EXISTS app_listing_red_media`);
  await split.db.exec(`TRUNCATE app_listings, "Image", "User" CASCADE`);
  await split.applyMigration();
  if (redSlots) await split.applyRedSlotsMigration();
  await split.seed({ listingIds: [LISTING_ID, PARENT_ID, SHADOW_ID], users: [MOD] });
  await split.seedImages(
    Object.entries(LEVELS).map(([id, nsfwLevel]) => ({
      id: Number(id),
      nsfwLevel,
      ingestion: INGESTION[Number(id)] ?? 'Scanned',
    }))
  );
  split.route(mockWrite as never);
  split.route(mockRead as never);
}

function wireImages() {
  for (const c of [mockRead, mockWrite]) {
    c.image.findMany
      .mockReset()
      .mockImplementation(async (args: { where?: { id?: { in?: number[] } } }) =>
        (args?.where?.id?.in ?? []).map((id) => ({
          id,
          ingestion: INGESTION[id] ?? 'Scanned',
          nsfwLevel: LEVELS[id] ?? NsfwLevel.PG,
        }))
      );
    c.appListingScreenshot.findMany.mockReset().mockResolvedValue([{ imageId: SHOT }]);
  }
}

function wireFirstApprove(kind: 'onsite' | 'offsite') {
  const listing = {
    id: LISTING_ID,
    status: 'pending',
    externalUrl: kind === 'offsite' ? 'https://cool.app' : null,
    iconId: ICON,
    coverId: COVER,
    revisionOfId: null,
    connectClientId: null,
    connectRequestedScopes: null,
    connectScopeJustifications: null,
    connectClient: null,
    userId: OWNER,
    name: 'Cool App',
    slug: 'cool-app',
    kind,
    contentRating: 'g',
    appBlockId: kind === 'onsite' ? 'apb_1' : null,
  };
  mockRead.appListingPublishRequest.findUnique.mockReset().mockResolvedValue({
    id: REQUEST_ID,
    status: 'pending',
    kind,
    slug: 'cool-app',
    appListingId: LISTING_ID,
  });
  for (const c of [mockRead, mockWrite])
    c.appListing.findUnique.mockReset().mockResolvedValue(listing);
  wireImages();
}

function wireRevision(kind: 'onsite' | 'offsite') {
  const parent = { id: PARENT_ID, slug: 'cool-app', status: 'approved', kind, contentRating: 'g' };
  const shadow = {
    id: SHADOW_ID,
    status: 'draft',
    revisionOfId: PARENT_ID,
    externalUrl: kind === 'offsite' ? 'https://cool.app' : null,
    iconId: ICON,
    coverId: COVER,
    connectClientId: null,
    connectRequestedScopes: null,
    connectScopeJustifications: null,
    connectClient: null,
    userId: OWNER,
    name: 'Cool App',
    tagline: null,
    description: null,
    category: null,
    contentRating: 'g',
    slug: 'rev-y',
    kind,
  };
  mockRead.appListingPublishRequest.findUnique.mockReset().mockResolvedValue({
    id: REQUEST_ID,
    status: 'pending',
    kind,
    slug: 'cool-app',
    appListingId: SHADOW_ID,
  });
  for (const c of [mockRead, mockWrite])
    c.appListing.findUnique
      .mockReset()
      .mockImplementation(async (args: { where: { id: string } }) =>
        args.where.id === PARENT_ID ? parent : args.where.id === SHADOW_ID ? shadow : null
      );
  wireImages();
}

const approve = (mediaSplit?: ListingMediaSplitDecision) =>
  approveExternalRequest({ publishRequestId: REQUEST_ID, reviewerUserId: MOD, mediaSplit });

function goLiveWrite(): { data: Record<string, unknown> } | undefined {
  const flip = mockWrite.appListing.updateMany.mock.calls.find(
    (c: { data?: { status?: string } }[]) => c[0]?.data?.status === 'approved'
  );
  if (flip) return flip[0];
  return mockWrite.appListing.update.mock.calls.find(
    (c: { where?: { id?: string } }[]) => c[0]?.where?.id === PARENT_ID
  )?.[0];
}

function expectRating(rates: boolean, rating: string) {
  const write = goLiveWrite();
  expect(write).toBeDefined();
  if (rates) expect(write?.data.contentRating).toBe(rating);
  else expect(write?.data).not.toHaveProperty('contentRating');
}

beforeEach(async () => {
  vi.clearAllMocks();
  mockWrite.$transaction
    .mockReset()
    .mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockWrite));
  for (const c of [mockRead, mockWrite]) {
    c.appListing.updateMany.mockReset().mockResolvedValue({ count: 1 });
    c.appListing.update.mockReset().mockImplementation(async (a: { data: unknown }) => a.data);
    // The shadow delete really deletes it in PGlite too, so its overrides row CASCADES away
    // as it does in production — an apply that ran after the delete would find nothing staged.
    c.appListing.deleteMany
      .mockReset()
      .mockImplementation(async (args: { where: { id?: string } }) => {
        if (args?.where?.id)
          await split.db.query(`DELETE FROM app_listings WHERE id = $1`, [args.where.id]);
        return { count: 1 };
      });
    c.appListingPublishRequest.updateMany.mockReset().mockResolvedValue({ count: 1 });
  }
  mockWrite.appBlock.updateMany.mockReset().mockResolvedValue({ count: 1 });
  await resetTables(true);
});

const SITES = [
  {
    site: 'on-site listing request (raise-only floor)',
    wire: () => wireFirstApprove('onsite'),
    goesLive: LISTING_ID,
    rates: true,
  },
  {
    site: 'off-site approve (derived replaces)',
    wire: () => wireFirstApprove('offsite'),
    goesLive: LISTING_ID,
    rates: true,
  },
  {
    site: 'off-site revision apply',
    wire: () => wireRevision('offsite'),
    goesLive: SHADOW_ID,
    rates: true,
  },
  {
    // Assets-only: the override is applied but the rating is not rewritten (as for every other
    // asset of an on-site media revision).
    site: 'on-site media revision apply',
    wire: () => wireRevision('onsite'),
    goesLive: SHADOW_ID,
    rates: false,
  },
];

describe.each(SITES)('$site', ({ wire, goesLive, rates }) => {
  it(
    rates
      ? '🔴 without a split, an R civitai.red icon floors the listing to R'
      : 'invariant guard: the assets-only apply writes no rating, an R override or not',
    async () => {
      await split.setRedSlots(goesLive, { icon: R_OVERRIDE });
      wire();
      await approve();
      expectRating(rates, 'r');
    }
  );

  it(
    rates
      ? '🔴 a SFW override floors it too without a split: a PG-13 civitai.red icon rates the listing PG-13'
      : 'invariant guard: the assets-only apply writes no rating for a PG-13 override either',
    async () => {
      await split.setRedSlots(goesLive, { icon: PG13_OVERRIDE });
      wire();
      await approve();
      expectRating(rates, 'pg13');
    }
  );

  it(
    rates
      ? 'invariant guard: with a split, an override never floors the rating — even a PG-13 one civitai.com could show'
      : 'invariant guard: with a split, the assets-only apply writes no rating for a PG-13 override',
    async () => {
      // PG-13 is civitai.com-eligible by LEVEL, so only the override mark keeps it out of a
      // split's floor; an R override would be dropped by the level check alone.
      await split.setRedSlots(goesLive, { icon: PG13_OVERRIDE });
      wire();
      await approve('split');
      expectRating(rates, 'g');
    }
  );

  it('invariant guard: with a split, an R override never floors the rating', async () => {
    await split.setRedSlots(goesLive, { icon: R_OVERRIDE });
    wire();
    await approve('split');
    expectRating(rates, 'g');
  });

  it('positive control: with no override the same listing stays g', async () => {
    wire();
    await approve();
    expectRating(rates, 'g');
  });

  it('🔴 a Blocked override is refused at go-live, and nothing goes live', async () => {
    await split.setRedSlots(goesLive, { icon: BLOCKED_OVERRIDE });
    wire();
    await expect(approve()).rejects.toThrow(/blocked: civitai\.red icon/);
    expect(goLiveWrite()).toBeUndefined();
  });

  it('🔴 a still-scanning override is refused at go-live, and nothing goes live', async () => {
    await split.setRedSlots(goesLive, { cover: SCANNING_OVERRIDE });
    wire();
    await expect(approve()).rejects.toThrow(/still scanning: civitai\.red cover/);
    expect(goLiveWrite()).toBeUndefined();
  });

  it('override columns absent: the approve goes live exactly as before them', async () => {
    await resetTables(false);
    wire();
    await approve();
    expectRating(rates, 'g');
  });
});

describe.each(SITES.filter((s) => s.goesLive === SHADOW_ID))(
  '$site — the overrides reach the live listing',
  ({ wire }) => {
    it('🔴 the revision’s overrides replace the live ones', async () => {
      await split.setRedSlots(PARENT_ID, { icon: R_OVERRIDE, cover: null });
      await split.setRedSlots(SHADOW_ID, { icon: null, cover: PG13_OVERRIDE });
      wire();
      await approve('split');
      expect(await split.redSlots(PARENT_ID)).toEqual({ icon: null, cover: PG13_OVERRIDE });
    });

    it('invariant guard (T10): a revision that staged no overrides leaves the live ones in place', async () => {
      await split.setRedSlots(PARENT_ID, { icon: R_OVERRIDE, cover: PG13_OVERRIDE });
      wire();
      await approve('split');
      expect(await split.redSlots(PARENT_ID)).toEqual({
        icon: R_OVERRIDE,
        cover: PG13_OVERRIDE,
      });
    });
  }
);

describe('off-site revision apply — the rating is floored by the overrides that END UP live', () => {
  it('🔴 a revision that staged no overrides keeps the live R override, so without a split it rates R', async () => {
    // No shadow row: `applyRevisionRedSlots` leaves the parent's R icon live, so the rating
    // must count it — reading the shadow's (none) would lower a live listing to g under it.
    await split.setRedSlots(PARENT_ID, { icon: R_OVERRIDE });
    wireRevision('offsite');
    await approve();
    expectRating(true, 'r');
    expect(await split.redSlots(PARENT_ID)).toEqual({ icon: R_OVERRIDE, cover: null });
  });

  it('positive control: a revision that CLEARED both overrides (a row of nulls) rates by its own media, g', async () => {
    await split.setRedSlots(PARENT_ID, { icon: R_OVERRIDE });
    await split.setRedSlots(SHADOW_ID, { icon: null, cover: null });
    wireRevision('offsite');
    await approve();
    expectRating(true, 'g');
    expect(await split.redSlots(PARENT_ID)).toEqual({ icon: null, cover: null });
  });

  it('positive control: the shadow’s staged PG-13 override replaces the live R one, and rates PG-13', async () => {
    await split.setRedSlots(PARENT_ID, { icon: R_OVERRIDE });
    await split.setRedSlots(SHADOW_ID, { icon: PG13_OVERRIDE });
    wireRevision('offsite');
    await approve();
    expectRating(true, 'pg13');
  });

  it('invariant guard: with a split the kept live R override does not floor it', async () => {
    await split.setRedSlots(PARENT_ID, { icon: R_OVERRIDE });
    wireRevision('offsite');
    await approve('split');
    expectRating(true, 'g');
  });
});

describe.each(SITES.filter((s) => s.goesLive === SHADOW_ID))(
  '$site — the scan gate checks the overrides that END UP live',
  ({ wire }) => {
    it('🔴 a revision that staged no overrides keeps a live Blocked override, so it is refused', async () => {
      // No shadow row: `applyRevisionRedSlots` leaves the parent's Blocked icon live, so the
      // gate must check it — reading the shadow's (none) would put a Blocked image back live.
      await split.setRedSlots(PARENT_ID, { icon: BLOCKED_OVERRIDE });
      wire();
      await expect(approve()).rejects.toThrow(/blocked: civitai\.red icon/);
      expect(goLiveWrite()).toBeUndefined();
    });

    it('🔴 a revision that staged no overrides keeps a live still-scanning override, so it is refused', async () => {
      await split.setRedSlots(PARENT_ID, { cover: SCANNING_OVERRIDE });
      wire();
      await expect(approve()).rejects.toThrow(/still scanning: civitai\.red cover/);
      expect(goLiveWrite()).toBeUndefined();
    });

    it('positive control: a revision that CLEARED both overrides (a row of nulls) is not refused for the live Blocked one', async () => {
      await split.setRedSlots(PARENT_ID, { icon: BLOCKED_OVERRIDE });
      await split.setRedSlots(SHADOW_ID, { icon: null, cover: null });
      wire();
      await approve();
      expect(goLiveWrite()).toBeDefined();
      expect(await split.redSlots(PARENT_ID)).toEqual({ icon: null, cover: null });
    });
  }
);
