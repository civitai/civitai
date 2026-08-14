import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * App Listing COLLABORATORS — the RECIPIENT INBOX (`listMyPendingTransfers`).
 *
 * 🔴 THIS READ IS WHAT MAKES OWNERSHIP TRANSFER REACHABLE, and its absence is why the
 * four transfer procs shipped unwired. Every other transfer read is keyed on the LISTING
 * (`getPendingTransfer` takes an `appListingId`), which is a question only somebody who
 * already knows the app can ask — and a pending offer confers NO role, so the recipient
 * resolves no access to it and, in the ordinary case, does not know it exists. The
 * `(to_user_id, status)` index was built for this shape and had no reader in the app.
 *
 * The properties pinned here:
 *   - the LEAK direction: an offer addressed to somebody else is never returned;
 *   - only `pending` rows;
 *   - an EXPIRED row is absent, by the same read-time predicate the accept path uses;
 *   - the listing metadata the UI needs comes back with it.
 *
 * 🔴 THE FAKE HONOURS ITS `where` CLAUSE, and that is load-bearing rather than tidy: a
 * `findMany` fake that ignored the clause would return every row to every caller, which
 * makes the leak test — the one that matters most here — pass no matter what the service
 * queries. `the fake CAN filter` below is the positive control for exactly that.
 */

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    appOwnershipTransfer: {
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    },
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));

const { listMyPendingTransfers } = await import(
  '~/server/services/blocks/app-ownership-transfer.service'
);

const ME = 20;
const SOMEONE_ELSE = 30;
const OWNER = 10;
const NOW = new Date('2026-08-10T12:00:00Z');
const FUTURE = new Date('2026-08-17T12:00:00Z');
const PAST = new Date('2026-08-03T12:00:00Z');

type Row = {
  id: string;
  appListingId: string;
  fromUserId: number;
  toUserId: number;
  status: string;
  expiresAt: Date;
  createdAt: Date;
  appListing: {
    slug: string;
    name: string;
    kind: string;
    appBlockId: string | null;
    icon: { url: string } | null;
  } | null;
};

/**
 * The transfer table. Every row differs from every other in id, listing, recipient,
 * status, expiry AND listing name, so no assertion can be satisfied by the wrong row.
 */
function transferTable(): Row[] {
  return [
    {
      id: 'aot_mine_onsite',
      appListingId: 'apl_onsite',
      fromUserId: OWNER,
      toUserId: ME,
      status: 'pending',
      expiresAt: FUTURE,
      createdAt: new Date('2026-08-09T00:00:00Z'),
      appListing: {
        slug: 'shiny-thing',
        name: 'Shiny Thing',
        kind: 'onsite',
        appBlockId: 'ab_shiny',
        icon: { url: 'https://img.example/shiny.png' },
      },
    },
    {
      id: 'aot_mine_offsite',
      appListingId: 'apl_offsite',
      fromUserId: 11,
      toUserId: ME,
      status: 'pending',
      expiresAt: FUTURE,
      createdAt: new Date('2026-08-08T00:00:00Z'),
      appListing: {
        slug: 'external-thing',
        name: 'External Thing',
        kind: 'offsite',
        appBlockId: null,
        icon: null,
      },
    },
    // 🔴 THE LEAK ROW — a live, perfectly valid offer addressed to somebody else.
    {
      id: 'aot_not_mine',
      appListingId: 'apl_secret',
      fromUserId: 12,
      toUserId: SOMEONE_ELSE,
      status: 'pending',
      expiresAt: FUTURE,
      createdAt: new Date('2026-08-09T06:00:00Z'),
      appListing: {
        slug: 'someone-elses-app',
        name: 'Someone Else’s App',
        kind: 'onsite',
        appBlockId: 'ab_secret',
        icon: null,
      },
    },
    // Addressed to me, but already answered.
    {
      id: 'aot_mine_accepted',
      appListingId: 'apl_done',
      fromUserId: 13,
      toUserId: ME,
      status: 'accepted',
      expiresAt: FUTURE,
      createdAt: new Date('2026-08-01T00:00:00Z'),
      appListing: {
        slug: 'already-taken',
        name: 'Already Taken',
        kind: 'onsite',
        appBlockId: 'ab_done',
        icon: null,
      },
    },
    {
      id: 'aot_mine_cancelled',
      appListingId: 'apl_gone',
      fromUserId: 14,
      toUserId: ME,
      status: 'cancelled',
      expiresAt: FUTURE,
      createdAt: new Date('2026-08-02T00:00:00Z'),
      appListing: {
        slug: 'withdrawn',
        name: 'Withdrawn',
        kind: 'offsite',
        appBlockId: null,
        icon: null,
      },
    },
    // Addressed to me, still `pending` in the column, but past its deadline.
    {
      id: 'aot_mine_expired',
      appListingId: 'apl_stale',
      fromUserId: 15,
      toUserId: ME,
      status: 'pending',
      expiresAt: PAST,
      createdAt: new Date('2026-07-25T00:00:00Z'),
      appListing: {
        slug: 'lapsed-offer',
        name: 'Lapsed Offer',
        kind: 'onsite',
        appBlockId: 'ab_stale',
        icon: null,
      },
    },
  ];
}

let ROWS: Row[];

beforeEach(() => {
  vi.clearAllMocks();
  ROWS = transferTable();
  mockDb.appOwnershipTransfer.findMany.mockImplementation(async (args: unknown) => {
    const where = (args as { where?: { toUserId?: number; status?: string } }).where ?? {};
    return ROWS.filter(
      (r) =>
        (where.toUserId === undefined || r.toUserId === where.toUserId) &&
        (where.status === undefined || r.status === where.status)
    );
  });
});

describe('listMyPendingTransfers — the fake', () => {
  /**
   * 🔴 POSITIVE CONTROL ON THE FIXTURE ITSELF. Every assertion below is about rows the
   * service did NOT return, and a fake that ignored `where` would hand back everything —
   * making the leak test green while the service leaked. This proves the clause bites,
   * and that the two users' rows are disjoint and both non-empty, so a filter can be
   * observed to have happened at all.
   */
  it('CAN filter — the where clause actually narrows the table', async () => {
    const mine = (await mockDb.appOwnershipTransfer.findMany({
      where: { toUserId: ME, status: 'pending' },
    })) as Row[];
    const theirs = (await mockDb.appOwnershipTransfer.findMany({
      where: { toUserId: SOMEONE_ELSE, status: 'pending' },
    })) as Row[];
    const everything = (await mockDb.appOwnershipTransfer.findMany({})) as Row[];

    expect(mine.length).toBeGreaterThan(0);
    expect(theirs.length).toBeGreaterThan(0);
    expect(everything.length).toBeGreaterThan(mine.length + theirs.length);
    expect(mine.map((r) => r.id)).not.toContain('aot_not_mine');
    expect(theirs.map((r) => r.id)).toEqual(['aot_not_mine']);
  });
});

describe('listMyPendingTransfers', () => {
  it('returns the caller’s LIVE pending offers', async () => {
    const rows = await listMyPendingTransfers(ME, NOW);
    expect(rows.map((r) => r.transferId)).toEqual(['aot_mine_onsite', 'aot_mine_offsite']);
  });

  /**
   * 🔴 THE LEAK TEST. An ownership offer names both parties and the app; showing one to a
   * third party discloses that somebody is handing over an app, to whom, and by when.
   */
  it('🔴 NEVER returns an offer addressed to a DIFFERENT user', async () => {
    const rows = await listMyPendingTransfers(ME, NOW);
    expect(rows.map((r) => r.transferId)).not.toContain('aot_not_mine');
    expect(rows.map((r) => r.appListingId)).not.toContain('apl_secret');
    expect(rows.every((r) => r.transferId !== 'aot_not_mine')).toBe(true);
    // POSITIVE CONTROL: that offer is real, live, and visible to ITS OWN recipient — so
    // its absence above is the filter working, not the fixture being empty.
    const theirs = await listMyPendingTransfers(SOMEONE_ELSE, NOW);
    expect(theirs.map((r) => r.transferId)).toEqual(['aot_not_mine']);
  });

  it('🔴 the query is SCOPED IN THE `where`, on the indexed (to_user_id, status) pair', async () => {
    await listMyPendingTransfers(ME, NOW);
    const args = mockDb.appOwnershipTransfer.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(args.where).toMatchObject({ toUserId: ME, status: 'pending' });
  });

  it('excludes ACCEPTED and CANCELLED offers', async () => {
    const ids = (await listMyPendingTransfers(ME, NOW)).map((r) => r.transferId);
    expect(ids).not.toContain('aot_mine_accepted');
    expect(ids).not.toContain('aot_mine_cancelled');
  });

  /**
   * 🔴 EXPIRY IS A READ-TIME PREDICATE, matching `getPendingTransfer` and `acceptTransfer`
   * — no sweeper job is involved, so a lapsed row must be invisible even though its
   * `status` column still says `pending`.
   */
  it('🔴 an EXPIRED pending row is ABSENT even though its status column says pending', async () => {
    const ids = (await listMyPendingTransfers(ME, NOW)).map((r) => r.transferId);
    expect(ids).not.toContain('aot_mine_expired');
    // POSITIVE CONTROL: the row IS in the table and IS `pending` — it is the deadline
    // that removed it, not the status filter.
    const raw = ROWS.find((r) => r.id === 'aot_mine_expired');
    expect(raw?.status).toBe('pending');
    expect(raw?.toUserId).toBe(ME);
  });

  it('…and the SAME row is returned when "now" is before its deadline', async () => {
    const ids = (await listMyPendingTransfers(ME, new Date('2026-07-28T00:00:00Z'))).map(
      (r) => r.transferId
    );
    expect(ids).toContain('aot_mine_expired');
  });

  /**
   * The recipient holds NO role on the listing, so they cannot look any of this up. If it
   * does not arrive with the offer, the UI has nothing to render but an opaque id.
   */
  it('returns the listing metadata the inbox renders', async () => {
    const [onsite, offsite] = await listMyPendingTransfers(ME, NOW);
    expect(onsite).toEqual({
      transferId: 'aot_mine_onsite',
      appListingId: 'apl_onsite',
      slug: 'shiny-thing',
      name: 'Shiny Thing',
      kind: 'onsite',
      appBlockId: 'ab_shiny',
      iconUrl: 'https://img.example/shiny.png',
      fromUserId: OWNER,
      expiresAt: FUTURE,
      createdAt: new Date('2026-08-09T00:00:00Z'),
    });
    // An OFF-SITE offer legitimately carries no block and no icon — absent, not missing.
    expect(offsite.kind).toBe('offsite');
    expect(offsite.appBlockId).toBeNull();
    expect(offsite.iconUrl).toBeNull();
    expect(offsite.name).toBe('External Thing');
  });

  it('names the OFFERING user, so the recipient can see who is handing it over', async () => {
    const rows = await listMyPendingTransfers(ME, NOW);
    expect(rows.map((r) => r.fromUserId)).toEqual([OWNER, 11]);
    // POSITIVE CONTROL: the offerers are distinct from each other and from the recipient,
    // so a mixed-up column is observable.
    expect(new Set([OWNER, 11, ME]).size).toBe(3);
  });

  it('a row whose listing relation is missing is DROPPED, not rendered blank', async () => {
    ROWS.push({
      id: 'aot_orphan',
      appListingId: 'apl_vanished',
      fromUserId: 16,
      toUserId: ME,
      status: 'pending',
      expiresAt: FUTURE,
      createdAt: new Date('2026-08-09T12:00:00Z'),
      appListing: null,
    });
    const ids = (await listMyPendingTransfers(ME, NOW)).map((r) => r.transferId);
    expect(ids).not.toContain('aot_orphan');
    // POSITIVE CONTROL: the other rows still come back, so the drop is targeted.
    expect(ids).toEqual(['aot_mine_onsite', 'aot_mine_offsite']);
  });

  it('an empty inbox is an empty array, not a throw', async () => {
    await expect(listMyPendingTransfers(999, NOW)).resolves.toEqual([]);
  });
});
