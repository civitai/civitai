import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * W13 POST-APPROVAL MOD MANAGEMENT (P2) — the moderator ALL-STATUS listings read
 * (`listAllListingsForModeration`). We do NOT hit a DB — `dbRead.appListing.findMany`
 * is mocked so we can assert the WHERE (status/kind/search + shadow exclusion), the
 * keyset (orderBy id DESC, take limit+1, cursor skip), the pagination contract
 * (nextCursor only on page+1), the limit clamp (≤50), and the projected row shape
 * (owner chip, metric counts default 0, the latest pending-request projection).
 */

const { mockDbRead } = vi.hoisted(() => ({
  mockDbRead: {
    $queryRaw: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    appListing: {
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    },
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbRead }));
vi.mock('~/client-utils/cf-images-utils', () => ({ getEdgeUrl: (src: string) => src }));
vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'civit.ai' } }));
vi.mock('~/server/common/constants', () => ({ CacheTTL: { hour: 3600 } }));
vi.mock('~/server/utils/cache-helpers', () => ({
  queryCache:
    () =>
    async (sql: unknown): Promise<unknown[]> =>
      mockDbRead.$queryRaw(sql),
}));

import {
  listAllListingsForModeration,
  projectModerationListing,
} from '../app-listing.service';

/** A hydrated moderation row as `moderationListingSelect` returns it. */
function modRow(over: Record<string, unknown> = {}) {
  return {
    id: 'apl_9',
    slug: 'cool-app',
    name: 'Cool App',
    kind: 'offsite',
    status: 'approved',
    category: 'utility',
    contentRating: 'pg',
    externalUrl: 'https://ext.example/app',
    appBlockId: null,
    user: { id: 7, username: 'dev', image: 'avatar-key' },
    metric: { installCount: 5, thumbsUpCount: 9, thumbsDownCount: 1 },
    publishRequests: [],
    ...over,
  };
}

/** The last findMany call's args. */
function lastFindMany() {
  return mockDbRead.appListing.findMany.mock.calls.at(-1)?.[0] as {
    where?: Record<string, unknown>;
    orderBy?: unknown;
    take?: number;
    cursor?: unknown;
    skip?: number;
  };
}

describe('projectModerationListing', () => {
  it('projects the row DTO (owner chip, counts, no pending request)', () => {
    const dto = projectModerationListing(modRow() as never);
    expect(dto).toMatchObject({
      id: 'apl_9',
      slug: 'cool-app',
      name: 'Cool App',
      kind: 'offsite',
      status: 'approved',
      category: 'utility',
      contentRating: 'pg',
      externalUrl: 'https://ext.example/app',
      appBlockId: null,
      owner: { id: 7, username: 'dev', image: 'avatar-key' },
      installCount: 5,
      thumbsUpCount: 9,
      thumbsDownCount: 1,
      pendingRequest: null,
    });
  });

  it('defaults metric counts to 0 when there is no metric row', () => {
    const dto = projectModerationListing(modRow({ metric: null }) as never);
    expect(dto.installCount).toBe(0);
    expect(dto.thumbsUpCount).toBe(0);
    expect(dto.thumbsDownCount).toBe(0);
  });

  it('projects the LATEST pending publish request when present', () => {
    const dto = projectModerationListing(
      modRow({
        status: 'pending',
        publishRequests: [
          {
            id: 'alpr_1',
            submittedAt: new Date('2026-01-02T00:00:00Z'),
            changelog: 'first version',
            submittedBy: { id: 42, username: 'author', image: null },
          },
        ],
      }) as never
    );
    expect(dto.pendingRequest).toEqual({
      id: 'alpr_1',
      submittedAt: new Date('2026-01-02T00:00:00Z'),
      changelog: 'first version',
      submittedBy: { id: 42, username: 'author', image: null },
    });
  });

  it('a vanished owner yields a null owner chip', () => {
    expect(projectModerationListing(modRow({ user: null }) as never).owner).toBeNull();
  });
});

describe('listAllListingsForModeration — filters, keyset + pagination', () => {
  beforeEach(() => {
    mockDbRead.appListing.findMany.mockReset();
    mockDbRead.appListing.findMany.mockResolvedValue([]);
  });

  it('excludes shadow revision drafts (revisionOfId: null) and applies no filter by default', async () => {
    await listAllListingsForModeration({ limit: 25 });
    const { where, orderBy, take } = lastFindMany();
    expect(where).toEqual({ revisionOfId: null });
    expect(orderBy).toEqual({ id: 'desc' });
    expect(take).toBe(26); // limit + 1
  });

  it('binds the status filter when provided', async () => {
    await listAllListingsForModeration({ status: 'removed', limit: 25 });
    expect(lastFindMany().where).toMatchObject({ status: 'removed', revisionOfId: null });
  });

  it('binds the kind filter when provided', async () => {
    await listAllListingsForModeration({ kind: 'onsite', limit: 25 });
    expect(lastFindMany().where).toMatchObject({ kind: 'onsite' });
  });

  it('builds a case-insensitive name/slug OR for search (trimmed)', async () => {
    await listAllListingsForModeration({ search: '  Cool  ', limit: 25 });
    expect(lastFindMany().where).toMatchObject({
      OR: [
        { name: { contains: 'Cool', mode: 'insensitive' } },
        { slug: { contains: 'Cool', mode: 'insensitive' } },
      ],
    });
  });

  it('omits the search OR when the trimmed query is empty', async () => {
    await listAllListingsForModeration({ search: '   ', limit: 25 });
    expect(lastFindMany().where).not.toHaveProperty('OR');
  });

  it('clamps the page size to 50 (take = 51)', async () => {
    // The zod schema caps at 50, but the service double-clamps (it is exported).
    await listAllListingsForModeration({ limit: 999 as never });
    expect(lastFindMany().take).toBe(51);
  });

  it('passes the cursor as a keyset (cursor:{id}, skip:1)', async () => {
    await listAllListingsForModeration({ cursor: 'apl_5', limit: 25 });
    const call = lastFindMany();
    expect(call.cursor).toEqual({ id: 'apl_5' });
    expect(call.skip).toBe(1);
  });

  it('no cursor/skip on the first page', async () => {
    await listAllListingsForModeration({ limit: 25 });
    const call = lastFindMany();
    expect(call.cursor).toBeUndefined();
    expect(call.skip).toBeUndefined();
  });

  it('emits nextCursor = the last row id only when a full page+1 is returned', async () => {
    mockDbRead.appListing.findMany.mockResolvedValueOnce([
      modRow({ id: 'apl_3' }),
      modRow({ id: 'apl_2' }),
      modRow({ id: 'apl_1' }), // the +1 (dropped)
    ]);
    const { items, nextCursor } = await listAllListingsForModeration({ limit: 2 });
    expect(items.map((i) => i.id)).toEqual(['apl_3', 'apl_2']);
    expect(nextCursor).toBe('apl_2');
  });

  it('no nextCursor when the result fits in one page', async () => {
    mockDbRead.appListing.findMany.mockResolvedValueOnce([modRow({ id: 'apl_1' })]);
    const { items, nextCursor } = await listAllListingsForModeration({ limit: 25 });
    expect(items).toHaveLength(1);
    expect(nextCursor).toBeNull();
  });
});
