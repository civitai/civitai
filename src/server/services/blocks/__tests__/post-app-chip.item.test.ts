import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetDbWithoutLag } = vi.hoisted(() => {
  // Before the static imports: `server-domain.ts` reads these at import time.
  process.env.SERVER_DOMAIN_BLUE = 'civitai.com';
  process.env.SERVER_DOMAIN_RED = 'civitai.red';
  return { mockGetDbWithoutLag: vi.fn() };
});

vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveStoreVisibilityScope: vi.fn(async () => 'full'),
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDbWithoutLag: mockGetDbWithoutLag,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { readPostAppChip } from '~/server/services/blocks/post-app-chip.service';

const POST_ID = 31107522;
const APP_ID = 'game-frame-client';
const LISTING_ID = 'apl_games';
const HOST = 'civitai.com';

const appRow = (listingStatus = 'approved') => ({
  name: 'Game Frame Client',
  appBlocks: [
    {
      status: 'approved',
      currentVersionDeployedAt: new Date('2026-09-01T00:00:00.000Z'),
      appListing: {
        id: LISTING_ID,
        slug: 'game-frame',
        name: 'Game Frame',
        status: listingStatus,
        kind: 'onsite',
        contentRating: 'pg',
        revisionOfId: null,
        icon: null,
      },
    },
  ],
});

const PARENT_CHIP = { slug: 'game-frame', name: 'Game Frame', iconUrl: null };

type SubRow = {
  id: string;
  parentListingId: string;
  status: string;
  author: { bannedAt: Date | null; deletedAt: Date | null };
  title: string;
  subPath: string;
  contentRating: string | null;
  parentListing: {
    slug: string;
    kind: string;
    contentRating: string | null;
    subListingParent: { enabled: boolean; linkTemplate: string | null } | null;
  };
};

const subRow = (over: Partial<SubRow> = {}): SubRow => ({
  id: 'asl_FAKEFUL',
  parentListingId: LISTING_ID,
  status: 'approved',
  author: { bannedAt: null, deletedAt: null },
  title: 'Fakeful',
  subPath: 'fakeful',
  contentRating: null,
  parentListing: {
    slug: 'game-frame',
    kind: 'onsite',
    contentRating: 'pg',
    subListingParent: { enabled: true, linkTemplate: null },
  },
  ...over,
});

/** Every `where` field, nested ones included, must hold, so a dropped condition admits a row. */
function matches(row: unknown, where: Record<string, unknown>): boolean {
  const r = (row ?? {}) as Record<string, unknown>;
  return Object.entries(where).every(([k, v]) => {
    if (k === 'is') return matches(r, v as Record<string, unknown>);
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      const filter = v as Record<string, unknown>;
      if (Array.isArray(filter.in)) return filter.in.includes(r[k]);
      return matches(r[k], filter);
    }
    return r[k] === v;
  });
}

function given({
  subListingId,
  rows = [],
  app = appRow(),
}: {
  subListingId?: string;
  rows?: SubRow[];
  app?: unknown;
}) {
  const metadata: Record<string, unknown> = { blockPublishedAppId: APP_ID };
  if (subListingId) metadata.blockPublishedSubListingId = subListingId;
  mockGetDbWithoutLag.mockResolvedValue({ post: { findUnique: async () => ({ metadata }) } });
  dbMock.dbRead.oauthClient.findUnique.mockResolvedValue(app as never);
  dbMock.dbRead.appSubListing.findFirst.mockImplementation(
    (async ({ where }: { where: Record<string, unknown> }) =>
      rows.find((r) => matches(r, where)) ?? null) as never
  );
}

const read = (host = HOST) => readPostAppChip({ postId: POST_ID, host });

beforeEach(() => {
  dbMock.dbRead.oauthClient.findUnique.mockClear();
  dbMock.dbRead.appSubListing.findFirst.mockReset();
});

describe('the post chip names the sub-listing a post was shared from', () => {
  it('links an approved item under the app, where its store card links', async () => {
    given({ subListingId: 'asl_FAKEFUL', rows: [subRow()] });
    await expect(read()).resolves.toEqual({
      ...PARENT_CHIP,
      item: {
        name: 'Fakeful',
        href: '/apps/run/game-frame/fakeful?sl=asl_FAKEFUL',
        external: false,
      },
    });
  });

  it.each(['pending', 'hidden', 'withdrawn'])(
    'falls back to the app alone once the item is %s',
    async (status) => {
      given({ subListingId: 'asl_FAKEFUL', rows: [subRow({ status })] });
      await expect(read()).resolves.toEqual(PARENT_CHIP);
    }
  );

  it("never shows another app's item, even an approved one", async () => {
    given({
      subListingId: 'asl_OTHER',
      rows: [subRow({ id: 'asl_OTHER', parentListingId: 'apl_other_app' })],
    });
    await expect(read()).resolves.toEqual(PARENT_CHIP);
  });

  it.each([
    ['banned', { bannedAt: new Date('2026-10-01'), deletedAt: null }],
    ['deleted', { bannedAt: null, deletedAt: new Date('2026-10-01') }],
  ])('drops the item when its author is %s', async (_, author) => {
    given({ subListingId: 'asl_FAKEFUL', rows: [subRow({ author })] });
    await expect(read()).resolves.toEqual(PARENT_CHIP);
  });

  it('drops a mature item on a host that hides its rating, and shows it on red', async () => {
    given({ subListingId: 'asl_FAKEFUL', rows: [subRow({ contentRating: 'x' })] });
    await expect(read()).resolves.toEqual(PARENT_CHIP);
    await expect(read('civitai.red')).resolves.toMatchObject({ item: { name: 'Fakeful' } });
  });

  it('opens an off-site item at its platform link', async () => {
    const parentListing = {
      slug: 'game-frame',
      kind: 'offsite',
      contentRating: 'pg',
      subListingParent: { enabled: true, linkTemplate: 'https://games.civitai.com/play/{id}' },
    };
    given({ subListingId: 'asl_FAKEFUL', rows: [subRow({ parentListing })] });
    await expect(read()).resolves.toMatchObject({
      item: { name: 'Fakeful', href: 'https://games.civitai.com/play/fakeful', external: true },
    });
  });

  it('names an off-site item unlinked when its parent has no valid link', async () => {
    const parentListing = {
      slug: 'game-frame',
      kind: 'offsite',
      contentRating: 'pg',
      subListingParent: { enabled: true, linkTemplate: 'http://insecure.example/{id}' },
    };
    given({ subListingId: 'asl_FAKEFUL', rows: [subRow({ parentListing })] });
    await expect(read()).resolves.toMatchObject({
      item: { name: 'Fakeful', href: null, external: false },
    });
  });

  it.each([
    ['has no sub-listing switch', null],
    ['has switched its sub-listings off', { enabled: false, linkTemplate: null }],
  ])('drops the item when the app %s', async (_, subListingParent) => {
    const parentListing = { ...subRow().parentListing, subListingParent };
    given({ subListingId: 'asl_FAKEFUL', rows: [subRow({ parentListing })] });
    await expect(read()).resolves.toEqual(PARENT_CHIP);
  });

  it("finds the item under any of the app's viewable listings, not only the one it names", async () => {
    const app = appRow();
    const first = { ...app.appBlocks[0].appListing, id: 'apl_aaa', slug: 'aaa', name: 'Aaa' };
    app.appBlocks.unshift({ ...app.appBlocks[0], appListing: first });
    given({ subListingId: 'asl_FAKEFUL', rows: [subRow()], app });
    await expect(read()).resolves.toMatchObject({ slug: 'aaa', item: { name: 'Fakeful' } });
  });

  it("never shows an item under one of the app's listings the viewer cannot see", async () => {
    const app = appRow();
    const pending = { ...app.appBlocks[0].appListing, id: 'apl_pending', status: 'pending' };
    app.appBlocks.push({ ...app.appBlocks[0], appListing: pending });
    given({ subListingId: 'asl_FAKEFUL', rows: [subRow({ parentListingId: 'apl_pending' })], app });
    await expect(read()).resolves.toEqual(PARENT_CHIP);
  });

  it('strips hidden and reordering characters from the item name, and drops one left empty', async () => {
    given({ subListingId: 'asl_FAKEFUL', rows: [subRow({ title: '\u202eFake\u200bful\n' })] });
    await expect(read()).resolves.toMatchObject({ item: { name: 'Fakeful' } });
    given({ subListingId: 'asl_FAKEFUL', rows: [subRow({ title: '\u200b\u202e' })] });
    await expect(read()).resolves.toEqual(PARENT_CHIP);
  });

  it('leaves a post with no item marker unchanged, with no item read', async () => {
    given({ rows: [subRow()] });
    await expect(read()).resolves.toEqual(PARENT_CHIP);
    expect(dbMock.dbRead.appSubListing.findFirst).not.toHaveBeenCalled();
  });

  it('shows no item while the app itself is not viewable', async () => {
    given({ subListingId: 'asl_FAKEFUL', rows: [subRow()], app: appRow('pending') });
    await expect(read()).resolves.toEqual({ ...PARENT_CHIP, slug: null });
    expect(dbMock.dbRead.appSubListing.findFirst).not.toHaveBeenCalled();
  });

  it("keeps the app's chip when the item read fails, and logs it as an item read", async () => {
    loggingMock.logToAxiom.mockClear();
    given({ subListingId: 'asl_FAKEFUL' });
    dbMock.dbRead.appSubListing.findFirst.mockRejectedValue(new Error('replica down'));
    await expect(read()).resolves.toEqual(PARENT_CHIP);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'post-app-chip-read-degraded',
        read: 'item',
        message: 'replica down',
      })
    );
  });
});
