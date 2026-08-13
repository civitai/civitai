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
vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'civit.ai' } }));
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

/**
 * The seat table. 🔴 KEYED ON THE LISTING and carrying no block anywhere — which is the
 * whole point: an off-site listing has no `appBlockId` to key a seat with.
 */
const SEATS = [
  { appListingId: OFFSITE, userId: DISPLAYED, status: 'accepted', displayed: true },
  { appListingId: OFFSITE, userId: HIDDEN, status: 'accepted', displayed: false },
  { appListingId: OFFSITE, userId: PENDING, status: 'pending', displayed: true },
  { appListingId: OFFSITE, userId: REJECTED, status: 'rejected', displayed: true },
];

/**
 * Realistic over-wide user rows — the shape a careless upstream `select` produces. The
 * hydrator's own `select` narrows to three columns, so this fixture is deliberately
 * WIDER than what production returns: it is the only way to prove the projection
 * narrows rather than merely passing through an already-narrow row.
 */
const USERS: Record<number, Record<string, unknown>> = {
  [DISPLAYED]: {
    id: DISPLAYED,
    username: 'editor-shown',
    image: 'shown.png',
    email: 'shown@example.com',
    bannedAt: new Date('2026-01-01T00:00:00Z'),
    isModerator: true,
  },
  [HIDDEN]: { id: HIDDEN, username: 'editor-hidden', image: null, email: 'hidden@example.com' },
  [PENDING]: { id: PENDING, username: 'invitee', image: null },
  [REJECTED]: { id: REJECTED, username: 'decliner', image: null },
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
  mockDb.user.findMany.mockImplementation(async (args: unknown) => {
    const ids = (args as { where: { id: { in: number[] } } }).where.id.in;
    return ids.map((id) => USERS[id]).filter(Boolean);
  });
});

describe('🔴 INSTRUMENT CONTROLS', () => {
  it('the seat fake honours appListingId, status AND displayed', async () => {
    const all = (await mockDb.appCollaborator.findMany({
      where: { appListingId: OFFSITE },
    })) as Array<{ userId: number }>;
    expect(all.map((r) => r.userId).sort()).toEqual([DISPLAYED, HIDDEN, PENDING, REJECTED].sort());

    const byline = (await mockDb.appCollaborator.findMany({
      where: { appListingId: OFFSITE, status: 'accepted', displayed: true },
    })) as Array<{ userId: number }>;
    expect(byline.map((r) => r.userId)).toEqual([DISPLAYED]);

    // …and a DIFFERENT listing id returns nothing, so "it found rows" is a statement
    // about the key and not about a fake that answers everything.
    const other = await mockDb.appCollaborator.findMany({ where: { appListingId: 'apl_other' } });
    expect(other).toEqual([]);
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
