import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 🔴 THE PUBLIC BYLINE ON AN OFF-SITE LISTING — end to end, through the real read.
 *
 * This is the user-visible payoff of keying seats to `AppListing` instead of `AppBlock`.
 * BEFORE the re-key the byline hydrator took an `appBlockId` and short-circuited on
 * null, so an off-site listing's byline was **structurally always empty**: not a bug in
 * the filter, not a missing seat — there was no id to query with. Nothing went red,
 * because nothing asked.
 *
 * So this suite drives the actual public read (`getListingDetail`, the anon-capable
 * store-detail path) against an OFF-SITE row and asserts the three properties that
 * matter, in the same call:
 *
 *   1. an accepted + displayed collaborator APPEARS;
 *   2. pending / rejected / accepted-but-undisplayed do NOT — consent and the byline
 *      opt-out are both enforced on a read that anonymous users can reach; and
 *   3. the projection is EXACTLY `{id, username, image}`, even when the user rows the
 *      hydrator is handed carry more.
 *
 * `app-access.service.test.ts` pins the filter in isolation and
 * `app-collaborator.public-projection.test.ts` pins the DTO in isolation. Neither can
 * see the SEAM — which is precisely where the pre-re-key defect lived.
 */

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    appCollaborator: {
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    },
    user: { findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []) },
    $queryRaw: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    appListing: {
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    },
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));
vi.mock('~/client-utils/cf-images-utils', () => ({ getEdgeUrl: (src: string) => src }));
vi.mock('~/server/common/constants', () => ({ CacheTTL: { hour: 3600 } }));
vi.mock('~/server/utils/cache-helpers', () => ({
  queryCache:
    () =>
    async (sql: unknown): Promise<unknown[]> =>
      mockDb.$queryRaw(sql),
}));

import { getListingDetail } from '../app-listing.service';

const OFFSITE = 'apl_offsite';
const OWNER = 7;
const DISPLAYED = 20;
const HIDDEN = 21;
const PENDING = 30;
const REJECTED = 40;
/** Accepted + displayed, but BANNED — must not keep a public placement. */
const BANNED = 50;
/** Accepted + displayed, but soft-DELETED. */
const DELETED = 60;

/**
 * The seat table. 🔴 KEYED ON THE LISTING and carrying no block anywhere — which is the
 * whole point: an off-site listing has no `appBlockId` to key a seat with.
 */
const SEATS = [
  { appListingId: OFFSITE, userId: DISPLAYED, status: 'accepted', displayed: true },
  { appListingId: OFFSITE, userId: HIDDEN, status: 'accepted', displayed: false },
  { appListingId: OFFSITE, userId: PENDING, status: 'pending', displayed: true },
  { appListingId: OFFSITE, userId: REJECTED, status: 'rejected', displayed: true },
  // 🔴 Both of these pass the SEAT filters (accepted + displayed) and must still be
  // excluded — by the USER filter, which is a separate gate on a separate table.
  { appListingId: OFFSITE, userId: BANNED, status: 'accepted', displayed: true },
  { appListingId: OFFSITE, userId: DELETED, status: 'accepted', displayed: true },
];

/**
 * Realistic over-wide user rows — the shape a careless upstream `select` produces. The
 * hydrator's own `select` narrows to three columns, so this fixture is deliberately
 * WIDER than what production returns: it is the only way to prove the projection
 * narrows rather than merely passing through an already-narrow row.
 */
const USERS: Record<number, Record<string, unknown>> = {
  /**
   * 🔴 This row is deliberately OVER-WIDE (email, isModerator) so the projection's
   * three-key allowlist is provably doing work — but it is NOT banned.
   *
   * It used to carry `bannedAt: new Date(...)`, purely as another extra field, and that
   * was harmless only because nothing filtered on it. The fixture was therefore asserting
   * that a BANNED user appears in the public byline — which is exactly the defect the
   * filter below now closes. Keep the over-wide shape; keep the account healthy.
   */
  [DISPLAYED]: {
    id: DISPLAYED,
    username: 'editor-shown',
    image: 'shown.png',
    email: 'shown@example.com',
    bannedAt: null,
    deletedAt: null,
    isModerator: true,
  },
  [HIDDEN]: { id: HIDDEN, username: 'editor-hidden', image: null, email: 'hidden@example.com' },
  [PENDING]: { id: PENDING, username: 'invitee', image: null },
  [REJECTED]: { id: REJECTED, username: 'decliner', image: null },
  [BANNED]: {
    id: BANNED,
    username: 'banned-editor',
    image: 'banned.png',
    bannedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
  },
  // 🔴 A soft delete keeps the username, so the chip component's username-skip does NOT
  // catch this one — only an explicit filter does.
  [DELETED]: {
    id: DELETED,
    username: 'deleted-editor',
    image: 'deleted.png',
    bannedAt: null,
    deletedAt: new Date('2026-02-01T00:00:00Z'),
  },
};

/** An approved OFF-SITE external-link listing, as `listingHydrateSelect` returns it. */
function offsiteRow(over: Record<string, unknown> = {}) {
  return {
    id: OFFSITE,
    serialId: 2,
    kind: 'offsite',
    slug: 'ext-app',
    name: 'External App',
    tagline: 't',
    description: 'body',
    category: 'utility',
    contentRating: 'pg',
    externalUrl: 'https://example.com/',
    connectClientId: null,
    // 🔴 NO backing AppBlock — the state that made the byline unreachable before.
    appBlockId: null,
    appBlock: null,
    icon: null,
    cover: null,
    user: { id: OWNER, username: 'dev', image: null },
    metric: null,
    screenshots: [],
    status: 'approved',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.appListing.findFirst.mockResolvedValue(offsiteRow());
  // Honour `appListingId`, `status` AND `displayed` — a fake that ignored any of the
  // three would make the corresponding assertion below vacuous.
  mockDb.appCollaborator.findMany.mockImplementation(async (args: unknown) => {
    const w = (args as { where: { appListingId?: string; status?: string; displayed?: boolean } })
      .where;
    return SEATS.filter(
      (s) =>
        (w.appListingId === undefined || s.appListingId === w.appListingId) &&
        (w.status === undefined || s.status === w.status) &&
        (w.displayed === undefined || s.displayed === w.displayed)
    ).map((s) => ({ userId: s.userId }));
  });
  // 🔴 Honours `bannedAt` / `deletedAt` as well as the id set. A fake that ignored them
  // would make every assertion about those filters vacuous — and this fake DID ignore
  // them, which is why a banned collaborator sat in the byline fixture unnoticed.
  mockDb.user.findMany.mockImplementation(async (args: unknown) => {
    const w = (
      args as {
        where: { id: { in: number[] }; bannedAt?: null; deletedAt?: null };
      }
    ).where;
    return w.id.in
      .map((id) => USERS[id])
      .filter(Boolean)
      .filter((u) => !('bannedAt' in w) || u.bannedAt == null)
      .filter((u) => !('deletedAt' in w) || u.deletedAt == null);
  });
});

describe('🔴 INSTRUMENT CONTROLS', () => {
  it('the seat fake honours appListingId, status AND displayed', async () => {
    const all = (await mockDb.appCollaborator.findMany({
      where: { appListingId: OFFSITE },
    })) as Array<{ userId: number }>;
    expect(all.map((r) => r.userId).sort()).toEqual(
      [DISPLAYED, HIDDEN, PENDING, REJECTED, BANNED, DELETED].sort()
    );

    const byline = (await mockDb.appCollaborator.findMany({
      where: { appListingId: OFFSITE, status: 'accepted', displayed: true },
    })) as Array<{ userId: number }>;
    // 🔴 THREE rows pass the SEAT filters. Only the USER filter narrows it to one, which
    // is what makes the banned/deleted assertions below a different gate.
    expect(byline.map((r) => r.userId).sort()).toEqual([DISPLAYED, BANNED, DELETED].sort());

    // …and a DIFFERENT listing id returns nothing, so "it found rows" is a statement
    // about the key and not about a fake that answers everything.
    const other = await mockDb.appCollaborator.findMany({ where: { appListingId: 'apl_other' } });
    expect(other).toEqual([]);
  });

  it('🔴 the user fake honours bannedAt / deletedAt (else the filter tests are vacuous)', async () => {
    const unfiltered = (await mockDb.user.findMany({
      where: { id: { in: [DISPLAYED, BANNED, DELETED] } },
    })) as Array<{ id: number }>;
    // POSITIVE CONTROL: without the clauses the fake returns all three…
    expect(unfiltered.map((u) => u.id).sort()).toEqual([DISPLAYED, BANNED, DELETED].sort());
    // …and with them, exactly the healthy one.
    const filtered = (await mockDb.user.findMany({
      where: { id: { in: [DISPLAYED, BANNED, DELETED] }, bannedAt: null, deletedAt: null },
    })) as Array<{ id: number }>;
    expect(filtered.map((u) => u.id)).toEqual([DISPLAYED]);
  });

  it('the user fake really does return over-wide rows', async () => {
    const rows = (await mockDb.user.findMany({ where: { id: { in: [DISPLAYED] } } })) as Array<
      Record<string, unknown>
    >;
    expect(Object.keys(rows[0])).toContain('email');
    expect(Object.keys(rows[0])).toContain('bannedAt');
  });
});

describe('🔴 an OFF-SITE listing carries a public collaborator byline', () => {
  it('the accepted + displayed collaborator APPEARS on the public detail', async () => {
    const detail = await getListingDetail({ slug: 'ext-app' }, { scope: 'public-external' });
    expect(detail).not.toBeNull();
    expect(detail!.collaborators.map((c) => c.id)).toEqual([DISPLAYED]);
  });

  /**
   * 🔴 A BANNED OR DELETED COLLABORATOR IS NOT A PUBLIC BYLINE. This read is what puts a
   * third party's name and avatar on a public app page, linked to their profile — and
   * this PR is what renders that field for the first time, so the filter belongs with it.
   *
   * Deleted accounts fell out only INCIDENTALLY before: a hard delete nulls `username` and
   * the chip component skips username-less rows. That is luck, not a filter, and a SOFT
   * delete keeps the username, so it did not even hold.
   */
  it('a BANNED collaborator is absent from the public byline', async () => {
    const detail = await getListingDetail({ slug: 'ext-app' }, { scope: 'public-external' });
    const ids = detail!.collaborators.map((c) => c.id);
    expect(ids).not.toContain(BANNED);
    // Beside the absence, the presence — so this is not passing on an empty byline.
    expect(ids).toContain(DISPLAYED);
  });

  it('a soft-DELETED collaborator is absent, despite still having a username', async () => {
    const detail = await getListingDetail({ slug: 'ext-app' }, { scope: 'public-external' });
    const ids = detail!.collaborators.map((c) => c.id);
    expect(ids).not.toContain(DELETED);
    expect(ids).toContain(DISPLAYED);
  });

  it('the byline is EXACTLY the healthy, accepted, displayed seat', () => {
    // The whole population in one assertion: 6 seats, 1 chip.
    return getListingDetail({ slug: 'ext-app' }, { scope: 'public-external' }).then((detail) => {
      expect(detail!.collaborators.map((c) => c.id)).toEqual([DISPLAYED]);
    });
  });

  it('🔴 the byline is read under the LISTING id — the assertion the re-key exists for', async () => {
    await getListingDetail({ slug: 'ext-app' }, { scope: 'public-external' });
    expect(mockDb.appCollaborator.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { appListingId: OFFSITE, status: 'accepted', displayed: true },
      })
    );
  });

  it('🔴 CONSENT: a PENDING invitee is absent — a listing cannot borrow a stranger’s name', async () => {
    const detail = await getListingDetail({ slug: 'ext-app' }, { scope: 'public-external' });
    expect(detail!.collaborators.map((c) => c.id)).not.toContain(PENDING);
  });

  it('🔴 a REJECTED invitee is absent', async () => {
    const detail = await getListingDetail({ slug: 'ext-app' }, { scope: 'public-external' });
    expect(detail!.collaborators.map((c) => c.id)).not.toContain(REJECTED);
  });

  it('🔴 OPT-OUT: an accepted collaborator with `displayed: false` is absent', async () => {
    const detail = await getListingDetail({ slug: 'ext-app' }, { scope: 'public-external' });
    expect(detail!.collaborators.map((c) => c.id)).not.toContain(HIDDEN);
  });

  it('🔴 THE ALLOWLIST survives the whole read: exactly {id, username, image}', async () => {
    // The hydrator is handed a row carrying email/bannedAt/isModerator; an anon-capable
    // read must emit none of them.
    const detail = await getListingDetail({ slug: 'ext-app' }, { scope: 'public-external' });
    const chip = detail!.collaborators[0];
    expect(Object.keys(chip).sort()).toEqual(['id', 'image', 'username']);
    expect(chip).not.toHaveProperty('email');
    expect(chip).not.toHaveProperty('bannedAt');
    expect(chip).not.toHaveProperty('isModerator');
    expect(chip).toEqual({ id: DISPLAYED, username: 'editor-shown', image: 'shown.png' });
  });

  it('a listing with NO seats still projects an empty array, never undefined', async () => {
    mockDb.appCollaborator.findMany.mockResolvedValue([]);
    const detail = await getListingDetail({ slug: 'ext-app' }, { scope: 'public-external' });
    expect(detail!.collaborators).toEqual([]);
    // …and it does not go looking up users it has no ids for.
    expect(mockDb.user.findMany).not.toHaveBeenCalled();
  });

  it('the byline degrades to EMPTY when the manual-apply migration has not landed', async () => {
    // `safeCollaboratorQuery` swallows only the missing-TABLE error, so the public store
    // page keeps rendering instead of 500ing for every visitor.
    mockDb.appCollaborator.findMany.mockRejectedValue(
      Object.assign(new Error('relation "app_collaborators" does not exist'), { code: 'P2021' })
    );
    const detail = await getListingDetail({ slug: 'ext-app' }, { scope: 'public-external' });
    expect(detail!.collaborators).toEqual([]);
  });

  it('🔴 NEGATIVE CONTROL: a genuine query failure is NOT swallowed into an empty byline', async () => {
    // Otherwise this read would be a permanent silent-zero generator and a broken byline
    // would be indistinguishable from an app with no collaborators.
    mockDb.appCollaborator.findMany.mockRejectedValue(
      Object.assign(new Error('connection reset'), { code: 'P1001' })
    );
    await expect(
      getListingDetail({ slug: 'ext-app' }, { scope: 'public-external' })
    ).rejects.toThrow('connection reset');
  });
});

describe('the ONSITE byline still works (regression guard)', () => {
  it('an onsite listing reads its byline under its OWN listing id, not its block id', async () => {
    // The re-key had to not break the case that already worked. `appBlockId` is present
    // on this row and must NOT be what the seat query uses.
    const ONSITE = 'apl_onsite';
    mockDb.appListing.findFirst.mockResolvedValue(
      offsiteRow({
        id: ONSITE,
        kind: 'onsite',
        slug: 'cool-app',
        externalUrl: null,
        appBlockId: 'ab_1',
        appBlock: { manifest: {}, currentVersionDeployedAt: new Date('2026-01-01T00:00:00Z') },
      })
    );
    mockDb.appCollaborator.findMany.mockImplementation(async (args: unknown) => {
      const w = (args as { where: { appListingId?: string } }).where;
      return w.appListingId === ONSITE ? [{ userId: DISPLAYED }] : [];
    });
    const detail = await getListingDetail({ slug: 'cool-app' }, { scope: 'full' });
    expect(detail!.collaborators.map((c) => c.id)).toEqual([DISPLAYED]);
    expect(mockDb.appCollaborator.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ appListingId: ONSITE }) })
    );
  });
});
