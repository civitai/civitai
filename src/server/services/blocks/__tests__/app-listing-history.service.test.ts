import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `listListingHistory` — the LAZY, per-row read behind an expanded `/apps/mine` row.
 *
 * 🔴 THE FINDING THIS FILE PINS. There are TWO publish-request tables and they are NOT
 * duplicates, so the merged history must UNION them rather than pick one or deduplicate:
 *
 *   - `app_block_publish_requests` — the CODE/VERSION stream. Written by
 *     `publish-request.service` (submit / submit-version / approve / reject / withdraw /
 *     the deploy callbacks) and by the suspend→re-queue clone in
 *     `offsite-moderation.service`. Carries `version`, `manifest`, `bundleSha256`,
 *     `deployState`.
 *   - `app_listing_publish_requests` — the STORE-LISTING stream. It has exactly THREE
 *     `create` sites in the tree, and only ONE of them can emit `kind: 'onsite'`:
 *     `submitListingRevision`, which passes `kind: shadow.kind`. So every on-site row in
 *     that table is a shadow-REVISION request (a change to the listing's name/media/
 *     category), never a code submission — `listMySubmissions` states the same invariant
 *     in prose: *"all onsite requests are shadow revisions"*.
 *
 * A version bump and a listing edit are DIFFERENT EVENTS on the same app. Deduplicating
 * them would delete real history; ignoring one table would hide half of it.
 *
 * DB deps mocked with the sibling convention. `resolveListingAccess` is deliberately NOT
 * stubbed — it runs for real against the fake `appListing.findUnique`, so the authorization
 * assertions below are about the real gate rather than about a stub.
 */

const { mockDb, mockWriteDb } = vi.hoisted(() => {
  const make = () => ({
    appBlock: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    },
    appListing: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    },
    appCollaborator: {
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    },
    appListingPublishRequest: {
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    },
    appBlockPublishRequest: {
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    },
  });
  return { mockDb: make(), mockWriteDb: make() };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockWriteDb }));

const { listListingHistory, LISTING_HISTORY_LIMIT } = await import(
  '~/server/services/blocks/app-listing-history.service'
);

const OWNER = 41;
const SEAT = 52;
const STRANGER = 63;

/** An ON-SITE listing owned by `OWNER` through its block's OauthClient. */
function onsiteListing(over: Record<string, unknown> = {}) {
  return {
    id: 'apl_main',
    userId: OWNER,
    kind: 'onsite',
    appBlockId: 'ab_main',
    revisionOfId: null,
    appBlock: { app: { userId: OWNER } },
    revisionOf: null,
    ...over,
  };
}

/** An OFF-SITE listing owned by `OWNER` through the column (no block at all). */
function offsiteListing(over: Record<string, unknown> = {}) {
  return {
    id: 'apl_ext',
    userId: OWNER,
    kind: 'offsite',
    appBlockId: null,
    revisionOfId: null,
    appBlock: null,
    revisionOf: null,
    ...over,
  };
}

const listingReq = (over: Record<string, unknown> & { id: string }) => ({
  status: 'approved',
  submittedAt: new Date('2026-05-01T00:00:00Z'),
  reviewedAt: null,
  rejectionReason: null,
  approvalNotes: null,
  changelog: null,
  ...over,
});

const blockReq = (over: Record<string, unknown> & { id: string }) => ({
  version: '1.0.0',
  status: 'approved',
  submittedAt: new Date('2026-05-01T00:00:00Z'),
  reviewedAt: null,
  rejectionReason: null,
  approvalNotes: null,
  deployState: null,
  deployUpdatedAt: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.appListing.findUnique.mockImplementation(async () => null);
  mockDb.appCollaborator.findFirst.mockImplementation(async () => null);
  mockDb.appListingPublishRequest.findMany.mockImplementation(async () => []);
  mockDb.appBlockPublishRequest.findMany.mockImplementation(async () => []);
});

describe('🔴 the two streams are UNIONED, not deduplicated', () => {
  it('an on-site app returns BOTH its version history and its listing revisions', async () => {
    mockDb.appListing.findUnique.mockImplementation(async () => onsiteListing());
    mockDb.appBlockPublishRequest.findMany.mockImplementation(async () => [
      blockReq({
        id: 'pubreq_v2',
        version: '2.0.0',
        submittedAt: new Date('2026-06-10T00:00:00Z'),
        deployState: 'live',
      }),
      blockReq({
        id: 'pubreq_v1',
        version: '1.0.0',
        submittedAt: new Date('2026-02-02T00:00:00Z'),
      }),
    ]);
    mockDb.appListingPublishRequest.findMany.mockImplementation(async () => [
      listingReq({
        id: 'alpr_edit',
        status: 'pending',
        submittedAt: new Date('2026-07-15T00:00:00Z'),
        changelog: 'new cover',
      }),
    ]);

    const out = await listListingHistory({ appListingId: 'apl_main', userId: OWNER });

    // Three DISTINCT events — one per row across the two tables. A dedup step would
    // collapse the on-site listing-revision into a version row and lose a real edit.
    expect(out.map((e) => e.id)).toEqual(['alpr_edit', 'pubreq_v2', 'pubreq_v1']);
    expect(out.map((e) => e.source)).toEqual(['listing', 'version', 'version']);
    // Each stream keeps the fields only it has.
    expect(out[0]).toMatchObject({ version: null, changelog: 'new cover', deployState: null });
    expect(out[1]).toMatchObject({ version: '2.0.0', changelog: null, deployState: 'live' });
  });

  it('newest-first across BOTH tables, not table-by-table', async () => {
    mockDb.appListing.findUnique.mockImplementation(async () => onsiteListing());
    mockDb.appBlockPublishRequest.findMany.mockImplementation(async () => [
      blockReq({ id: 'b_new', submittedAt: new Date('2026-08-01T00:00:00Z') }),
      blockReq({ id: 'b_old', submittedAt: new Date('2026-01-01T00:00:00Z') }),
    ]);
    mockDb.appListingPublishRequest.findMany.mockImplementation(async () => [
      listingReq({ id: 'l_mid', submittedAt: new Date('2026-04-01T00:00:00Z') }),
    ]);
    const out = await listListingHistory({ appListingId: 'apl_main', userId: OWNER });
    // Interleaved: if the two lists were concatenated without a merge sort this would be
    // ['l_mid','b_new','b_old'].
    expect(out.map((e) => e.id)).toEqual(['b_new', 'l_mid', 'b_old']);
  });

  it('a same-instant tie is broken deterministically rather than left to insertion order', async () => {
    const t = new Date('2026-03-03T03:03:03Z');
    mockDb.appListing.findUnique.mockImplementation(async () => onsiteListing());
    mockDb.appBlockPublishRequest.findMany.mockImplementation(async () => [
      blockReq({ id: 'aaa', submittedAt: t }),
    ]);
    mockDb.appListingPublishRequest.findMany.mockImplementation(async () => [
      listingReq({ id: 'zzz', submittedAt: t }),
    ]);
    const out = await listListingHistory({ appListingId: 'apl_main', userId: OWNER });
    expect(out.map((e) => e.id)).toEqual(['zzz', 'aaa']);
  });
});

describe('🔴 the block query is CONDITIONAL on the block, not on the kind', () => {
  it('an off-site listing never queries the block table at all', async () => {
    mockDb.appListing.findUnique.mockImplementation(async () => offsiteListing());
    mockDb.appListingPublishRequest.findMany.mockImplementation(async () => [
      listingReq({ id: 'alpr_only' }),
    ]);
    const out = await listListingHistory({ appListingId: 'apl_ext', userId: OWNER });
    expect(out.map((e) => e.id)).toEqual(['alpr_only']);
    // 🔴 Issuing it with a null id would match every request whose block FK is still
    // unset — i.e. every OTHER app's pending first version — and hand them to this caller.
    expect(mockDb.appBlockPublishRequest.findMany).not.toHaveBeenCalled();
  });

  it('the block query is scoped to THIS app’s block id', async () => {
    mockDb.appListing.findUnique.mockImplementation(async () =>
      onsiteListing({ appBlockId: 'ab_specific', appBlock: { app: { userId: OWNER } } })
    );
    await listListingHistory({ appListingId: 'apl_main', userId: OWNER });
    const call = mockDb.appBlockPublishRequest.findMany.mock.calls[0][0] as {
      where: { appBlockId: string };
    };
    expect(call.where.appBlockId).toBe('ab_specific');
  });
});

describe('🔴 shadow revisions are folded in', () => {
  it('the listing query asks for the parent AND its shadows', async () => {
    mockDb.appListing.findUnique.mockImplementation(async () => offsiteListing());
    await listListingHistory({ appListingId: 'apl_ext', userId: OWNER });
    const call = mockDb.appListingPublishRequest.findMany.mock.calls[0][0] as {
      where: { OR: Array<Record<string, unknown>> };
    };
    // A revision request targets a HIDDEN shadow whose `revisionOfId` is the parent, so a
    // query keyed on `appListingId` alone would miss every edit the author ever made.
    expect(call.where.OR).toEqual([
      { appListingId: 'apl_ext' },
      { appListing: { revisionOfId: 'apl_ext' } },
    ]);
  });

  it('a SHADOW id resolves to its parent before anything is queried', async () => {
    mockDb.appListing.findUnique.mockImplementation(async () => ({
      id: 'apl_shadow',
      userId: OWNER,
      kind: 'offsite',
      appBlockId: null,
      revisionOfId: 'apl_parent',
      appBlock: null,
      revisionOf: {
        id: 'apl_parent',
        userId: OWNER,
        kind: 'offsite',
        appBlockId: null,
        appBlock: null,
      },
    }));
    await listListingHistory({ appListingId: 'apl_shadow', userId: OWNER });
    const call = mockDb.appListingPublishRequest.findMany.mock.calls[0][0] as {
      where: { OR: Array<Record<string, unknown>> };
    };
    expect(call.where.OR[0]).toEqual({ appListingId: 'apl_parent' });
  });
});

describe('🔴 authorization is ownership∪seat, NEVER submittedByUserId', () => {
  it('neither query is scoped by submitter — that is the whole point of the merge', async () => {
    mockDb.appListing.findUnique.mockImplementation(async () => onsiteListing());
    await listListingHistory({ appListingId: 'apl_main', userId: OWNER });
    const listingWhere = JSON.stringify(
      (mockDb.appListingPublishRequest.findMany.mock.calls[0][0] as { where: unknown }).where
    );
    const blockWhere = JSON.stringify(
      (mockDb.appBlockPublishRequest.findMany.mock.calls[0][0] as { where: unknown }).where
    );
    // A submitter filter here would empty the history for a collaborator, for a transfer
    // recipient and for a moderator-claimed owner — the three populations `/apps/mine`
    // exists to serve.
    expect(listingWhere).not.toContain('submittedByUserId');
    expect(blockWhere).not.toContain('submittedByUserId');
  });

  it('an ACCEPTED collaborator — who submitted nothing — gets the full history', async () => {
    mockDb.appListing.findUnique.mockImplementation(async () => onsiteListing());
    mockDb.appCollaborator.findFirst.mockImplementation(async () => ({ userId: SEAT }));
    mockDb.appBlockPublishRequest.findMany.mockImplementation(async () => [
      blockReq({ id: 'pubreq_by_owner' }),
    ]);
    const out = await listListingHistory({ appListingId: 'apl_main', userId: SEAT });
    expect(out.map((e) => e.id)).toEqual(['pubreq_by_owner']);
  });

  it('a stranger with no seat is refused FORBIDDEN, not handed an empty list', async () => {
    mockDb.appListing.findUnique.mockImplementation(async () => onsiteListing());
    mockDb.appCollaborator.findFirst.mockImplementation(async () => null);
    // An empty list would read to the UI as "this app has no history", which is a lie.
    await expect(
      listListingHistory({ appListingId: 'apl_main', userId: STRANGER })
    ).rejects.toThrow(/do not have access/i);
  });

  it('an unknown listing is NOT_FOUND', async () => {
    mockDb.appListing.findUnique.mockImplementation(async () => null);
    await expect(listListingHistory({ appListingId: 'apl_nope', userId: OWNER })).rejects.toThrow(
      /not found/i
    );
  });
});

describe('bounds', () => {
  it('caps the merged result at the limit even when both tables are full', async () => {
    mockDb.appListing.findUnique.mockImplementation(async () => onsiteListing());
    const many = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `${prefix}_${String(i).padStart(3, '0')}`,
        submittedAt: new Date(2026, 0, 1, 0, i),
      }));
    mockDb.appBlockPublishRequest.findMany.mockImplementation(async () =>
      many('b', LISTING_HISTORY_LIMIT).map((r) => blockReq(r))
    );
    mockDb.appListingPublishRequest.findMany.mockImplementation(async () =>
      many('l', LISTING_HISTORY_LIMIT).map((r) => listingReq(r))
    );
    const out = await listListingHistory({ appListingId: 'apl_main', userId: OWNER });
    expect(out).toHaveLength(LISTING_HISTORY_LIMIT);
  });

  it('an explicit limit above the ceiling is clamped, not honoured', async () => {
    mockDb.appListing.findUnique.mockImplementation(async () => offsiteListing());
    await listListingHistory({ appListingId: 'apl_ext', userId: OWNER, limit: 9999 });
    const call = mockDb.appListingPublishRequest.findMany.mock.calls[0][0] as { take: number };
    expect(call.take).toBe(LISTING_HISTORY_LIMIT);
  });
});
