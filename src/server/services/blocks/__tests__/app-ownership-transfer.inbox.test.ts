import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CONNECT_CLIENT_TRANSFER_REFUSAL } from '~/shared/constants/app-transfer.constants';

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
 *
 * 🔴 AND IT NOW HONOURS ITS `select`, WHICH IT DID NOT. Until #3952 the fake filtered on
 * `where` and then handed back the WHOLE fixture row — so a column the service's `select`
 * never asked for was present anyway, and the mutant that DELETES `connectClientId: true`
 * from that select survived this entire suite. A canned fixture cannot observe a `select`,
 * by construction; only projection can. `the fake honours its select (positive control)`
 * below proves an unselected column really is absent, modelled on the identical control in
 * `app-access.authoring-context-connect-client.test.ts`.
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
    /**
     * 🔴 IN THE FIXTURE TABLE, NEVER IN THE SERVICE'S OUTPUT. The column is what
     * `refusesTransferForConnectClient` reads; the recipient receives only the derived
     * `acceptBlockedReason`. The leak assertion in `listMyPendingTransfers` below pins
     * that, and it can only mean anything because the column is genuinely present here.
     */
    connectClientId: string | null;
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
        connectClientId: null,
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
        connectClientId: null,
        icon: null,
      },
    },
    /**
     * 🔴 THE BLOCKED OFFER — off-site AND connect-linked, so `acceptTransfer` refuses it
     * in-transaction every time. Live, `pending`, in date, addressed to ME: indistinguish-
     * able from the row above on every other axis, which is precisely why the recipient
     * could not tell them apart until `acceptBlockedReason` existed.
     */
    {
      id: 'aot_mine_offsite_linked',
      appListingId: 'apl_offsite_linked',
      fromUserId: 17,
      toUserId: ME,
      status: 'pending',
      expiresAt: FUTURE,
      createdAt: new Date('2026-08-07T00:00:00Z'),
      appListing: {
        slug: 'connected-thing',
        name: 'Connected Thing',
        kind: 'offsite',
        appBlockId: null,
        connectClientId: 'oc_linked',
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
        connectClientId: null,
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
        connectClientId: null,
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
        // A CANCELLED offer on a connect-linked listing: the blocked branch must never be
        // reached for it, because the status filter removes the row first.
        appBlockId: null,
        connectClientId: 'oc_withdrawn',
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
        connectClientId: null,
        icon: null,
      },
    },
  ];
}

let ROWS: Row[];

type Select = Record<string, unknown>;

/**
 * Project one fixture row through a Prisma-style `select`, RECURSIVELY — a nested
 * `{ select: … }` on a relation narrows that relation the same way, and a `null` relation
 * stays `null`.
 *
 * 🔴 COLUMNS THE SELECT DID NOT ASK FOR ARE ABSENT, not merely undefined, because that is
 * what Prisma does and it is the only thing that makes the service's `select` OBSERVABLE.
 * The previous fake returned the whole fixture row after filtering, so deleting a line from
 * the service's `select` changed nothing here — the mutant survived a fully green suite.
 * No `select` at all still returns everything, which keeps the raw-fixture control below
 * able to read the table directly.
 */
function project(row: unknown, select: Select | undefined): unknown {
  if (row === null || row === undefined) return row;
  if (!select) return row;
  const source = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(select)) {
    if (!spec) continue;
    const nested = (spec as { select?: Select }).select;
    out[key] = nested ? project(source[key], nested) : source[key];
  }
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  ROWS = transferTable();
  mockDb.appOwnershipTransfer.findMany.mockImplementation(async (args: unknown) => {
    const a = (args ?? {}) as { where?: { toUserId?: number; status?: string }; select?: Select };
    const where = a.where ?? {};
    return ROWS.filter(
      (r) =>
        (where.toUserId === undefined || r.toUserId === where.toUserId) &&
        (where.status === undefined || r.status === where.status)
    ).map((r) => project(r, a.select));
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

describe('the fake honours its select (positive control)', () => {
  /**
   * 🔴 BEFORE BELIEVING ANY `select`-SENSITIVE ASSERTION BELOW: prove the fake can return
   * BOTH shapes, and that an unselected column really is ABSENT rather than merely
   * undefined. Without this, "the field came back" and "the fake returns everything
   * regardless" are indistinguishable — which is exactly the state this suite was in
   * before #3952, and why the `connectClientId` deletion mutant survived it.
   *
   * The nested arm matters as much as the flat one: the column the service reads lives on
   * the JOINED listing, so a projector that narrowed only the top level would be just as
   * blind as no projector at all.
   */
  it('omits a column the select did not ask for, and returns one it did', async () => {
    const asked = (await mockDb.appOwnershipTransfer.findMany({
      where: { toUserId: ME, status: 'pending' },
      select: { id: true, appListing: { select: { slug: true, connectClientId: true } } },
    })) as Array<Record<string, unknown>>;
    expect(asked[0]).toEqual({
      id: 'aot_mine_onsite',
      appListing: { slug: 'shiny-thing', connectClientId: null },
    });
    // The column IS on the fixture row — so its absence below is the projection, not a
    // hole in the table.
    expect('connectClientId' in (asked[0].appListing as object)).toBe(true);

    const notAsked = (await mockDb.appOwnershipTransfer.findMany({
      where: { toUserId: ME, status: 'pending' },
      select: { id: true, appListing: { select: { slug: true } } },
    })) as Array<Record<string, unknown>>;
    expect(notAsked[0]).toEqual({ id: 'aot_mine_onsite', appListing: { slug: 'shiny-thing' } });
    expect('connectClientId' in (notAsked[0].appListing as object)).toBe(false);
    // …and the top level narrows too: `fromUserId` was never asked for.
    expect('fromUserId' in notAsked[0]).toBe(false);
  });

  /** A `null` relation survives projection as `null`, not as an empty object. */
  it('a null relation stays null', async () => {
    ROWS = [
      {
        id: 'aot_orphan_probe',
        appListingId: 'apl_vanished',
        fromUserId: 16,
        toUserId: ME,
        status: 'pending',
        expiresAt: FUTURE,
        createdAt: NOW,
        appListing: null,
      },
    ];
    const rows = (await mockDb.appOwnershipTransfer.findMany({
      where: { toUserId: ME, status: 'pending' },
      select: { id: true, appListing: { select: { slug: true } } },
    })) as Array<Record<string, unknown>>;
    expect(rows).toEqual([{ id: 'aot_orphan_probe', appListing: null }]);
  });
});

describe('listMyPendingTransfers', () => {
  it('returns the caller’s LIVE pending offers', async () => {
    const rows = await listMyPendingTransfers(ME, NOW);
    expect(rows.map((r) => r.transferId)).toEqual([
      'aot_mine_onsite',
      'aot_mine_offsite',
      'aot_mine_offsite_linked',
    ]);
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
      // 🔴 EXHAUSTIVE `toEqual`, so a NEW field on the view has to be declared here — and
      // so this row is pinned as carrying the raw column NOWHERE. See the leak test below.
      acceptBlockedReason: null,
    });
    // An OFF-SITE offer legitimately carries no block and no icon — absent, not missing.
    expect(offsite.kind).toBe('offsite');
    expect(offsite.appBlockId).toBeNull();
    expect(offsite.iconUrl).toBeNull();
    expect(offsite.name).toBe('External Thing');
  });

  it('names the OFFERING user, so the recipient can see who is handing it over', async () => {
    const rows = await listMyPendingTransfers(ME, NOW);
    expect(rows.map((r) => r.fromUserId)).toEqual([OWNER, 11, 17]);
    // POSITIVE CONTROL: the offerers are distinct from each other and from the recipient,
    // so a mixed-up column is observable.
    expect(new Set([OWNER, 11, 17, ME]).size).toBe(4);
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
    expect(ids).toEqual(['aot_mine_onsite', 'aot_mine_offsite', 'aot_mine_offsite_linked']);
  });

  it('an empty inbox is an empty array, not a throw', async () => {
    await expect(listMyPendingTransfers(999, NOW)).resolves.toEqual([]);
  });
});

/**
 * 🔴 `acceptBlockedReason` — WHY AN OFFER CANNOT BE ACCEPTED, decided server-side.
 *
 * `acceptTransfer` re-asserts the connect-client refusal IN-TRANSACTION, so a live offer on
 * a connect-linked off-site listing is guaranteed to fail on accept. Until this field
 * existed the recipient's inbox had no way to know: `listMyPendingTransfers` did not read
 * the column, so the fact could not cross the wire at all, and the addressee met the
 * refusal only by pressing Accept.
 *
 * These pin the FIELD. The BRANCH that reads it lives in `AppTransferOffersView`, pinned by
 * `src/tests/pages/apps/invites-transfer-blocked.browser.test.tsx` — a field is not a guard.
 */
describe('🔴 listMyPendingTransfers — acceptBlockedReason', () => {
  it('an OFF-SITE offer on a connect-linked listing carries the server’s refusal, verbatim', async () => {
    const rows = await listMyPendingTransfers(ME, NOW);
    const blocked = rows.find((r) => r.transferId === 'aot_mine_offsite_linked');
    expect(blocked).toBeDefined();
    // VERBATIM against the constant the two server gates throw — a paraphrase here would
    // let the recipient's sentence drift out from under the owner's and the API's.
    expect(blocked?.acceptBlockedReason).toBe(CONNECT_CLIENT_TRANSFER_REFUSAL);
  });

  /**
   * 🔴 THE CONTROL, AND IT IS THE ARM THAT KILLS "block every offer". Without it, returning
   * the refusal unconditionally satisfies the test above and ships an inbox where nothing
   * can ever be accepted. The unblocked row is off-site too, so `kind` alone cannot explain
   * the difference — only the client id can.
   */
  it('🔴 CONTROL — an OFF-SITE offer with NO client is null, and an ON-SITE one is too', async () => {
    const rows = await listMyPendingTransfers(ME, NOW);
    const byId = Object.fromEntries(rows.map((r) => [r.transferId, r.acceptBlockedReason]));
    expect(byId).toEqual({
      aot_mine_onsite: null,
      aot_mine_offsite: null,
      aot_mine_offsite_linked: CONNECT_CLIENT_TRANSFER_REFUSAL,
    });
    // POSITIVE CONTROL on the fixture: the two off-site rows differ ONLY in the client id.
    const linked = ROWS.find((r) => r.id === 'aot_mine_offsite_linked');
    const unlinked = ROWS.find((r) => r.id === 'aot_mine_offsite');
    expect(linked?.appListing?.kind).toBe(unlinked?.appListing?.kind);
    expect(linked?.appListing?.connectClientId).toBe('oc_linked');
    expect(unlinked?.appListing?.connectClientId).toBeNull();
  });

  /**
   * 🔴 THE `kind` ARM OF THE PREDICATE, pinned against the SERVER's rule rather than a
   * guess. `refusesTransferForConnectClient` requires `kind === 'offsite'`, so an on-site
   * row carrying a client id is still transferable server-side and the inbox must agree —
   * blocking it here would refuse an offer `acceptTransfer` would have honoured.
   */
  it('an ON-SITE row carrying a client id is NOT blocked — the predicate needs both', async () => {
    const onsite = ROWS.find((r) => r.id === 'aot_mine_onsite');
    onsite!.appListing!.connectClientId = 'oc_onsite';
    const rows = await listMyPendingTransfers(ME, NOW);
    expect(rows.find((r) => r.transferId === 'aot_mine_onsite')?.acceptBlockedReason).toBeNull();
    // POSITIVE CONTROL: the same client id on the OFF-SITE row does block, so the value is
    // not simply being ignored.
    expect(rows.find((r) => r.transferId === 'aot_mine_offsite_linked')?.acceptBlockedReason).toBe(
      CONNECT_CLIENT_TRANSFER_REFUSAL
    );
  });

  /**
   * 🔴 THE RAW COLUMN NEVER CROSSES THE WIRE. A pending offeree holds no role on the
   * listing and this read imposes no status gate, so an offer can sit on a `draft`
   * listing whose client id the public listing-detail read does not expose. The derived
   * sentence is all they can act on, and all they get.
   */
  it('🔴 does NOT return the raw connectClientId to the recipient', async () => {
    const rows = await listMyPendingTransfers(ME, NOW);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect('connectClientId' in row).toBe(false);
    // POSITIVE CONTROL: the value IS in the fixture and DID reach the predicate — the row
    // it belongs to came back blocked. So its absence above is suppression, not a hole.
    expect(ROWS.find((r) => r.id === 'aot_mine_offsite_linked')?.appListing?.connectClientId).toBe(
      'oc_linked'
    );
    expect(rows.find((r) => r.transferId === 'aot_mine_offsite_linked')?.acceptBlockedReason).toBe(
      CONNECT_CLIENT_TRANSFER_REFUSAL
    );
  });

  /**
   * 🔴 THE `select` MUST ASK FOR THE COLUMN. This is the assertion the old whole-row fake
   * could not make: with projection in place, deleting `connectClientId: true` from the
   * service's select makes the row come back without it and the verdict silently becomes
   * `null` for everybody. Pinned on the ARGUMENTS as well, so the reason a failure happened
   * is legible rather than "one offer stopped being blocked".
   */
  it('🔴 the query SELECTS connectClientId off the joined listing', async () => {
    await listMyPendingTransfers(ME, NOW);
    const args = mockDb.appOwnershipTransfer.findMany.mock.calls[0][0] as {
      select: { appListing: { select: Record<string, unknown> } };
    };
    expect(args.select.appListing.select).toMatchObject({ connectClientId: true, kind: true });
  });
});
