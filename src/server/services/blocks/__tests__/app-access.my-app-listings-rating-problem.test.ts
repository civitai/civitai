import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `listMyAppListings` (`appListings.listMine`) — the service half of the
 * `hidden-mature-rating` advisory. The pure suite hands `computeListingProblems` the
 * rating fields directly; this proves the list read selects them and threads each row's
 * own. The `findMany` fake honours `select`, so a dropped projection reads `undefined`.
 */

const mockDb = dbMock.dbRead;

const { listMyAppListings } = await import('~/server/services/blocks/app-access.service');

const OWNER = 11;

type Stored = {
  id: string;
  slug: string;
  name: string;
  status: string;
  kind: string;
  appBlockId: string | null;
  updatedAt: Date;
  icon: { url: string | null } | null;
  cover: { url: string | null } | null;
  iconId: number | null;
  coverId: number | null;
  description: string | null;
  tagline: string | null;
  category: string | null;
  contentRating: string | null;
  appBlock: { contentRating: string | null } | null;
  _count: { screenshots: number };
  columnUserId: number;
};

/** Complete in every other dimension, so the rating problem is the only one that can fire. */
function stored(over: Partial<Stored> & { id: string }): Stored {
  return {
    slug: `slug-${over.id}`,
    name: `Name ${over.id}`,
    status: 'approved',
    kind: 'onsite',
    appBlockId: `ab-${over.id}`,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    icon: { url: 'icon-uuid' },
    cover: { url: 'cover-uuid' },
    iconId: 41,
    coverId: 53,
    description: 'A useful app.',
    tagline: 'Does the thing',
    category: 'utility',
    contentRating: 'g',
    appBlock: { contentRating: 'g' },
    _count: { screenshots: 7 },
    columnUserId: OWNER,
    ...over,
  };
}

function findManyFake(table: Stored[]) {
  return async (...a: unknown[]): Promise<unknown[]> => {
    const args = (a[0] ?? {}) as {
      where?: { OR?: Array<Record<string, unknown>>; id?: { in: string[] } };
      take?: number;
      select?: Record<string, unknown>;
    };
    const where = args.where ?? {};
    let rows = table;
    if (where.id?.in) rows = rows.filter((r) => where.id!.in.includes(r.id));
    if (where.OR) rows = rows.filter((r) => r.columnUserId === OWNER);
    const select = args.select;
    return rows.slice(0, args.take ?? rows.length).map((r) => {
      if (!select) return { ...r };
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(select)) {
        if (select[key]) out[key] = (r as unknown as Record<string, unknown>)[key];
      }
      return out;
    });
  };
}

async function problemsFor(id: string) {
  const rows = await listMyAppListings({ userId: OWNER });
  const row = rows.find((r) => r.appListingId === id);
  expect(row, `no row for ${id}`).toBeDefined();
  return row!.problems;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.appListing.findMany.mockImplementation(async () => []);
  mockDb.appCollaborator.findMany.mockImplementation(async () => []);
  mockDb.appListingScreenshot.findMany.mockImplementation(async () => []);
  mockDb.image.findMany.mockImplementation(async () => []);
});

describe('listMyAppListings — the hidden-mature-rating advisory', () => {
  const raised = stored({ id: 'l-raised', contentRating: 'r', appBlock: { contentRating: 'g' } });
  const declaredMature = stored({
    id: 'l-declared',
    contentRating: 'x',
    appBlock: { contentRating: 'x' },
  });
  const sfw = stored({ id: 'l-sfw', contentRating: 'pg13', appBlock: { contentRating: 'g' } });

  it('a listing raised above its declared rating says it is hidden and names both ratings', async () => {
    mockDb.appListing.findMany.mockImplementation(findManyFake([raised, declaredMature, sfw]));
    expect(await problemsFor('l-raised')).toEqual([
      {
        code: 'hidden-mature-rating',
        severity: 'advisory',
        label:
          'Rated R — hidden on civitai.com (visible on civitai.red). You declared G; a listing is rated at least as high as its most mature store image — check its images',
      },
    ]);
  });

  it('each row reads its OWN declared rating: a declared-mature row on the same page has no problem', async () => {
    mockDb.appListing.findMany.mockImplementation(findManyFake([raised, declaredMature, sfw]));
    expect(await problemsFor('l-declared')).toEqual([]);
  });

  it('a PG-13 row on the same page gets no rating problem', async () => {
    mockDb.appListing.findMany.mockImplementation(findManyFake([raised, declaredMature, sfw]));
    expect(await problemsFor('l-sfw')).toEqual([]);
  });

  it('a mature listing that is not approved is not flagged', async () => {
    mockDb.appListing.findMany.mockImplementation(findManyFake([{ ...raised, status: 'removed' }]));
    expect(await problemsFor('l-raised')).toEqual([]);
  });
});
