import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { createSplitDb, type SplitDb } from './listing-media-split.harness';

/**
 * The moderator's review reads a listing's media split through `getListingAssets`. The approve
 * records or clears the split through the WRITE client, so the review must report the split as
 * THAT client sees it — and say "cannot tell" (`null`) when it cannot read the table, never
 * "unsplit": the review would then preselect ending a split it did not show.
 *
 * The read and write clients here are two roles on one PGlite holding the REAL migration, each
 * with its own grant on the split table (`clientAs`), so a test can give them different grants.
 */

// The canonical `~/server/db/client` mock (`src/__tests__/setup.ts`); dbRead and dbWrite are
// distinct objects there, which is what lets each client hold its own grant below.
const clients = { dbRead: dbMock.dbRead, dbWrite: dbMock.dbWrite };

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const LISTING = 'apl_review';
const OWNER = 42;
const MOD = 7;
const owner = { id: OWNER, isModerator: false } as never;
const mod = { id: MOD, isModerator: true } as never;

type Privilege = 'SELECT' | 'INSERT' | 'UPDATE';
const ALL: Privilege[] = ['SELECT', 'INSERT', 'UPDATE'];

let s: SplitDb;
beforeAll(async () => {
  s = await createSplitDb();
  await s.applyMigration();
  await s.seed({ listingIds: [LISTING], users: [MOD] });
});
afterAll(() => s.db.close());

beforeEach(async () => {
  await s.db.exec(`TRUNCATE app_listing_red_media`);
  for (const c of [clients.dbRead, clients.dbWrite]) {
    c.appListing.findUnique.mockResolvedValue({
      id: LISTING,
      kind: 'onsite',
      slug: 'cool-app',
      name: 'Cool App',
      category: 'utility',
      contentRating: 'g',
      userId: OWNER,
      iconId: 1,
      coverId: 2,
      status: 'approved',
      revisionOfId: null,
    });
    c.appListingScreenshot.findMany.mockResolvedValue([
      { id: 's1', imageId: 10, order: 0, caption: null },
    ]);
    c.image.findMany.mockResolvedValue([]);
  }
});

const stampSplit = () =>
  s.db.query(
    `INSERT INTO app_listing_red_media (app_listing_id, media_split_approved_at, media_split_approved_by)
     VALUES ($1, now(), $2)`,
    [LISTING, MOD]
  );

/** Give each client its own role, holding only the named privileges on the split table. */
async function grant(read: Privilege[], write: Privilege[]) {
  for (const [client, privileges] of [
    [clients.dbRead, read],
    [clients.dbWrite, write],
  ] as const) {
    const raw = await s.clientAs([...privileges]);
    client.$queryRaw.mockImplementation(raw.$queryRaw as never);
    client.$executeRaw.mockImplementation(raw.$executeRaw as never);
  }
}

async function review(user = mod) {
  const { getListingAssets } = await import('../app-listing-assets.service');
  return getListingAssets({ listingId: LISTING }, user);
}

describe('getListingAssets — the media split the moderator reviews', () => {
  it('positive control: each client really holds only its own grant', async () => {
    await stampSplit();
    await grant([], ALL);
    const { readListingMediaSplitState } = await import('../listing-media-split.service');
    expect(await readListingMediaSplitState(clients.dbRead as never, LISTING)).toBeNull();
    expect(await readListingMediaSplitState(clients.dbWrite as never, LISTING)).toBe(true);
  });

  it('🔴 the read role cannot SELECT the table: a split listing still reviews as SPLIT', async () => {
    // The approve acts through the write client, which can see the stamp — so must the review.
    await stampSplit();
    await grant([], ALL);
    expect((await review()).mediaSplitApproved).toBe(true);
  });

  it('🔴 the write role cannot SELECT the table: the review reports "cannot tell", not unsplit', async () => {
    await stampSplit();
    await grant(['SELECT'], []);
    expect((await review()).mediaSplitApproved).toBeNull();
  });

  it('🔴 the same state, read by the AUTHOR, does not throw and returns the media', async () => {
    await stampSplit();
    await grant([], []);
    const res = await review(owner);
    expect(res.screenshots).toHaveLength(1);
    expect(res.completeness).toEqual({ complete: true });
    // Never "split" when it cannot be read; the fail-safe rating reads stay unsplit
    // (`listing-media-split.pglite.test.ts`).
    expect(res.mediaSplitApproved).not.toBe(true);
  });

  it('positive control: an unsplit listing reviews as unsplit through a granted write role', async () => {
    await grant([], ALL);
    expect((await review()).mediaSplitApproved).toBe(false);
  });
});
