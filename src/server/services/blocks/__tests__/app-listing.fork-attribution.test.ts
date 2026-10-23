import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';

/**
 * `getListingDetail` (served as `appListings.getAppDetail`) — the fork fields.
 *
 *   - `forkOf`: "Forked from …". The parent is named ONLY when this viewer could open the parent's
 *     store page, decided by the SAME gate the detail read applies to its own row. A parent the
 *     viewer cannot see (here: one that is still pending, one that is mature on a SFW host) reads
 *     exactly like a deleted one — `{ visible: false }` — and its name and slug appear NOWHERE in
 *     the DTO.
 *   - `forkable`: the author's opt-in, surfaced for an ON-SITE listing only.
 *
 * DB mocked; the provenance read is raw SQL, answered here by statement text. The SQL itself runs
 * for real in `app-fork.service.behavior.test.ts`.
 */

const { mockDbRead } = vi.hoisted(() => ({
  mockDbRead: {
    appCollaborator: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    user: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    appListing: {
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ sourceRepoUrl: null })),
    },
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbRead }));
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (src: string) => src }));
vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'civit.ai' } }));
vi.mock('~/server/common/constants', () => ({ CacheTTL: { hour: 3600, sm: 180 } }));
vi.mock('~/server/utils/cache-helpers', () => ({
  queryCache:
    () =>
    async (sql: unknown): Promise<unknown[]> =>
      mockDbRead.$queryRaw(sql),
  bustCacheTag: vi.fn(async () => undefined),
}));

import { getListingDetail } from '../app-listing.service';

// Pairwise-distinct fixtures; the hidden parent's name and slug are strings that occur nowhere
// else, so "not in the DTO" is a real check.
const FORK_ID = 'apl_fork_6001';
const PARENT_ID = 'apl_parent_6002';
const PARENT_NAME = 'Secret Parent Name';
const PARENT_SLUG = 'secret-parent-slug';

function listingRow(over: Record<string, unknown> = {}) {
  return {
    id: FORK_ID,
    kind: 'onsite',
    slug: 'the-fork',
    name: 'The Fork',
    status: 'approved',
    tagline: null,
    description: null,
    category: 'utility',
    contentRating: 'g',
    externalUrl: null,
    connectClientId: null,
    connectRequestedScopes: null,
    appBlockId: 'ab_fork_6101',
    icon: null,
    cover: null,
    user: { id: 61, username: 'forker', image: null },
    metric: null,
    updatedAt: new Date('2026-04-05T06:07:08.000Z'),
    appBlock: {
      currentVersionDeployedAt: new Date('2026-01-01T00:00:00Z'),
      manifest: { name: 'The Fork', page: { path: '/run' } },
    },
    screenshots: [],
    ...over,
  };
}

function parentRow(over: Record<string, unknown> = {}) {
  return listingRow({
    id: PARENT_ID,
    slug: PARENT_SLUG,
    name: PARENT_NAME,
    appBlockId: 'ab_parent_6102',
    user: { id: 62, username: 'original', image: null },
    ...over,
  });
}

/** Answer `findFirst` by the id it asks for — the detail row, then the parent lookup. */
function rows(byId: Record<string, unknown>) {
  mockDbRead.appListing.findFirst.mockImplementation(async (args: unknown) => {
    const where = (args as { where?: { id?: string; slug?: string } }).where ?? {};
    if (where.slug === 'the-fork') return byId[FORK_ID] ?? null;
    return (where.id && byId[where.id]) ?? null;
  });
}

/** Answer the raw provenance read; every other raw read (the visibility level) is empty. */
function provenance(
  row: { forkable: boolean; forkOfListingId: string | null; isFork: boolean } | null
) {
  mockDbRead.$queryRaw.mockImplementation(async (q: unknown) => {
    const text = (q as Prisma.Sql)?.text ?? '';
    if (text.includes('fork_of_listing_id')) return row ? [row] : [];
    return [];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDbRead.appListing.findUnique.mockResolvedValue({ sourceRepoUrl: null });
});

describe('getListingDetail — forkOf', () => {
  it('a parent the viewer may open is named and linked; the opt-in is surfaced', async () => {
    rows({ [FORK_ID]: listingRow(), [PARENT_ID]: parentRow() });
    provenance({ forkable: true, forkOfListingId: PARENT_ID, isFork: true });

    const detail = await getListingDetail({ slug: 'the-fork' }, { scope: 'full' });

    expect(detail?.forkOf).toEqual({ visible: true, slug: PARENT_SLUG, name: PARENT_NAME });
    expect(detail?.forkable).toBe(true);
  });

  it.each([
    ['still pending review', { status: 'pending' }, false],
    ['mature, on a SFW host', { contentRating: 'x' }, false],
  ])(
    '🔴 a parent the viewer may NOT open (%s) gets the generic line — no name, no slug',
    async (_why, over, redCapable) => {
      rows({ [FORK_ID]: listingRow(), [PARENT_ID]: parentRow(over) });
      provenance({ forkable: false, forkOfListingId: PARENT_ID, isFork: true });

      const detail = await getListingDetail({ slug: 'the-fork' }, { scope: 'full', redCapable });

      expect(detail?.forkOf).toEqual({ visible: false });
      const wire = JSON.stringify(detail);
      expect(wire).not.toContain(PARENT_NAME);
      expect(wire).not.toContain(PARENT_SLUG);
    }
  );

  it('a fork whose parent is gone (link nulled, still a fork) gets the generic line without a lookup', async () => {
    rows({ [FORK_ID]: listingRow() });
    provenance({ forkable: false, forkOfListingId: null, isFork: true });

    const detail = await getListingDetail({ slug: 'the-fork' }, { scope: 'full' });

    expect(detail?.forkOf).toEqual({ visible: false });
    expect(mockDbRead.appListing.findFirst).toHaveBeenCalledTimes(1);
  });

  it('an app that is not a fork has no attribution and costs no parent lookup', async () => {
    rows({ [FORK_ID]: listingRow() });
    provenance(null);

    const detail = await getListingDetail({ slug: 'the-fork' }, { scope: 'full' });

    expect(detail?.forkOf).toBeNull();
    expect(detail?.forkable).toBe(false);
    expect(mockDbRead.appListing.findFirst).toHaveBeenCalledTimes(1);
  });

  it('an OFF-SITE listing is never forkable, whatever its column says', async () => {
    rows({
      [FORK_ID]: listingRow({
        kind: 'offsite',
        appBlockId: null,
        appBlock: null,
        externalUrl: 'https://offsite.example.com',
      }),
    });
    provenance({ forkable: true, forkOfListingId: null, isFork: false });

    const detail = await getListingDetail({ slug: 'the-fork' }, { scope: 'full' });

    expect(detail?.forkable).toBe(false);
    expect(detail?.forkOf).toBeNull();
  });

  it('a failing provenance read degrades to "not a fork" instead of failing the page', async () => {
    rows({ [FORK_ID]: listingRow() });
    mockDbRead.$queryRaw.mockImplementation(async (q: unknown) => {
      const text = (q as Prisma.Sql)?.text ?? '';
      if (text.includes('fork_of_listing_id')) throw new Error('statement timeout');
      return [];
    });

    const detail = await getListingDetail({ slug: 'the-fork' }, { scope: 'full' });

    expect(detail?.name).toBe('The Fork');
    expect(detail?.forkOf).toBeNull();
    expect(detail?.forkable).toBe(false);
  });
});
