import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * App Listing COLLABORATORS — the consolidated access predicate.
 *
 * THE PERMISSION MATRIX lives here: role × subject × expected, across
 * owner / accepted editor / PENDING editor / REJECTED editor / stranger / anon.
 *
 * All DB deps are mocked (no real Prisma), following the sibling block-service
 * convention: a `vi.hoisted` fake client handed to BOTH `dbRead` and `dbWrite`.
 */

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    appBlock: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      // Declared here (not assigned ad-hoc in a test) so the mock's TYPE carries it —
      // `tsconfig.json` EXCLUDES `src/**/__tests__/**`, so a green `pnpm typecheck`
      // says nothing about this file and only an explicit test typecheck catches it.
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    },
    appListing: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    appCollaborator: {
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    },
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));

const {
  resolveAppAccess,
  resolveListingAccess,
  resolveAccessibleAppBlockIds,
  listDisplayedCollaboratorUserIds,
  listAppInsiderUserIds,
  safeCollaboratorQuery,
  assertAppEditAccess,
} = await import('~/server/services/blocks/app-access.service');

const APP = 'ab_app1';
const OWNER = 10;
const EDITOR = 20;
const PENDING = 30;
const REJECTED = 40;
const STRANGER = 50;

/** The seat table, as the fixture DB holds it. */
const SEATS = [
  { appBlockId: APP, userId: EDITOR, status: 'accepted', displayed: true },
  { appBlockId: APP, userId: PENDING, status: 'pending', displayed: true },
  { appBlockId: APP, userId: REJECTED, status: 'rejected', displayed: true },
];

/**
 * Drive `appCollaborator.findFirst` from the fixture, HONOURING the `status` filter.
 *
 * 🔴 Load-bearing: a mock that ignored `where.status` would make every consent test
 * pass vacuously — a pending seat would read as accepted and the suite would be green
 * against the exact bug it exists to catch.
 */
function wireSeats(rows = SEATS) {
  mockDb.appCollaborator.findFirst.mockImplementation(
    async (args: unknown): Promise<unknown> => {
      const w = (args as { where: { appBlockId: string; userId: number; status?: string } }).where;
      const hit = rows.find(
        (r) =>
          r.appBlockId === w.appBlockId &&
          r.userId === w.userId &&
          (w.status === undefined || r.status === w.status)
      );
      return hit ? { userId: hit.userId } : null;
    }
  );
  mockDb.appCollaborator.findMany.mockImplementation(async (args: unknown): Promise<unknown[]> => {
    const w = (args as { where: Record<string, unknown> }).where;
    return rows.filter(
      (r) =>
        (w.appBlockId === undefined || r.appBlockId === w.appBlockId) &&
        (w.userId === undefined || r.userId === w.userId) &&
        (w.status === undefined || r.status === w.status) &&
        (w.displayed === undefined || r.displayed === w.displayed)
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.appBlock.findUnique.mockResolvedValue({ id: APP, app: { userId: OWNER } });
  wireSeats();
});

describe('resolveAppAccess — the permission matrix', () => {
  const CASES: Array<[string, number | null, 'owner' | 'editor' | null]> = [
    ['owner', OWNER, 'owner'],
    ['accepted editor', EDITOR, 'editor'],
    // 🔴 THE CONSENT ROWS. A pending or rejected invite must confer ZERO capability —
    // otherwise anyone's name can be attached to a listing, and worse, an uninvited
    // stranger could be granted repo write by an owner unilaterally.
    ['PENDING editor', PENDING, null],
    ['REJECTED editor', REJECTED, null],
    ['stranger', STRANGER, null],
    ['anonymous', null, null],
  ];

  for (const [label, userId, expected] of CASES) {
    it(`${label} → role ${expected ?? 'null'}`, async () => {
      const access = await resolveAppAccess(APP, userId);
      expect(access).not.toBeNull();
      expect(access!.role).toBe(expected);
      expect(access!.ownerUserId).toBe(OWNER);
    });
  }

  it('POSITIVE CONTROL: the seat mock honours the status filter', async () => {
    // If this were not true, the PENDING/REJECTED rows above would pass vacuously.
    const asAccepted = await mockDb.appCollaborator.findFirst({
      where: { appBlockId: APP, userId: PENDING, status: 'accepted' },
    });
    const asAny = await mockDb.appCollaborator.findFirst({
      where: { appBlockId: APP, userId: PENDING },
    });
    expect(asAccepted).toBeNull();
    expect(asAny).toEqual({ userId: PENDING });
  });

  it('a missing AppBlock resolves null (not a role)', async () => {
    mockDb.appBlock.findUnique.mockResolvedValue(null);
    expect(await resolveAppAccess(APP, OWNER)).toBeNull();
  });

  it('an AppBlock with no resolvable owner resolves null — fail closed', async () => {
    // A dangling app_id: an app nobody owns is an app nobody may edit.
    mockDb.appBlock.findUnique.mockResolvedValue({ id: APP, app: null });
    expect(await resolveAppAccess(APP, OWNER)).toBeNull();
  });
});

describe('resolveListingAccess', () => {
  const LISTING = 'apl_live';
  const SHADOW = 'apl_shadow';

  function wireListing(row: Record<string, unknown> | null) {
    mockDb.appListing.findUnique.mockResolvedValue(row);
  }

  it('owner of the listing → owner', async () => {
    wireListing({ id: LISTING, userId: OWNER, appBlockId: APP, revisionOfId: null, revisionOf: null });
    expect((await resolveListingAccess(LISTING, OWNER))!.role).toBe('owner');
  });

  it('accepted collaborator on the backing AppBlock → editor', async () => {
    wireListing({ id: LISTING, userId: OWNER, appBlockId: APP, revisionOfId: null, revisionOf: null });
    expect((await resolveListingAccess(LISTING, EDITOR))!.role).toBe('editor');
  });

  it('pending collaborator → null', async () => {
    wireListing({ id: LISTING, userId: OWNER, appBlockId: APP, revisionOfId: null, revisionOf: null });
    expect((await resolveListingAccess(LISTING, PENDING))!.role).toBeNull();
  });

  it('🔴 SHADOW-AWARE: an editor keeps access to a shadow revision (appBlockId is NULL on it)', async () => {
    // A shadow carries appBlockId: null by construction (`appBlockId` is @unique and
    // stays on the parent). Without the revisionOf hop, an editor would LOSE access the
    // instant their first media edit minted the shadow — i.e. the feature would break
    // on its own second click.
    wireListing({
      id: SHADOW,
      userId: OWNER,
      appBlockId: null,
      revisionOfId: LISTING,
      revisionOf: { appBlockId: APP },
    });
    const access = await resolveListingAccess(SHADOW, EDITOR);
    expect(access!.appBlockId).toBe(APP);
    expect(access!.role).toBe('editor');
  });

  it('a listing with NO backing AppBlock anywhere resolves owner-or-nothing', async () => {
    // A natively-created offsite listing: there is no AppBlock to seat anyone on.
    wireListing({ id: LISTING, userId: OWNER, appBlockId: null, revisionOfId: null, revisionOf: null });
    expect((await resolveListingAccess(LISTING, EDITOR))!.role).toBeNull();
    expect((await resolveListingAccess(LISTING, OWNER))!.role).toBe('owner');
  });

  it('a missing listing resolves null', async () => {
    wireListing(null);
    expect(await resolveListingAccess(LISTING, OWNER)).toBeNull();
  });
});

describe('resolveAccessibleAppBlockIds', () => {
  const OTHER = 'ab_app2';

  beforeEach(() => {
    mockDb.appBlock.findUnique.mockResolvedValue({ id: APP, app: { userId: OWNER } });
  });

  it('an owner gets their owned ids and no editor ids', async () => {
    mockDb.appBlock.findMany.mockResolvedValue([{ id: APP }, { id: OTHER }]);
    wireSeats([]);
    const res = await resolveAccessibleAppBlockIds(OWNER);
    expect(res.ownedIds.sort()).toEqual([APP, OTHER].sort());
    expect(res.editorIds).toEqual([]);
    expect(res.allIds.sort()).toEqual([APP, OTHER].sort());
  });

  it('an editor gets ONLY the seated app — never the owner’s other apps', async () => {
    // The editor owns nothing; their seat is on APP only. OTHER must not appear.
    mockDb.appBlock.findMany.mockResolvedValue([]);
    wireSeats([{ appBlockId: APP, userId: EDITOR, status: 'accepted', displayed: true }]);
    const res = await resolveAccessibleAppBlockIds(EDITOR);
    expect(res.ownedIds).toEqual([]);
    expect(res.editorIds).toEqual([APP]);
    expect(res.allIds).toEqual([APP]);
    expect(res.allIds).not.toContain(OTHER);
  });

  it('a PENDING seat contributes nothing', async () => {
    mockDb.appBlock.findMany.mockResolvedValue([]);
    wireSeats([{ appBlockId: APP, userId: PENDING, status: 'pending', displayed: true }]);
    expect((await resolveAccessibleAppBlockIds(PENDING)).allIds).toEqual([]);
  });

  it('owned and editor sets are disjoint — an owner who also holds a seat counts once', async () => {
    mockDb.appBlock.findMany.mockResolvedValue([{ id: APP }]);
    wireSeats([{ appBlockId: APP, userId: OWNER, status: 'accepted', displayed: true }]);
    const res = await resolveAccessibleAppBlockIds(OWNER);
    expect(res.editorIds).toEqual([]);
    expect(res.allIds).toEqual([APP]);
  });
});

describe('listDisplayedCollaboratorUserIds vs listAppInsiderUserIds — the displayed asymmetry', () => {
  const HIDDEN = 60;

  beforeEach(() => {
    mockDb.appBlock.findUnique.mockResolvedValue({ id: APP, app: { userId: OWNER } });
    wireSeats([
      { appBlockId: APP, userId: EDITOR, status: 'accepted', displayed: true },
      { appBlockId: APP, userId: HIDDEN, status: 'accepted', displayed: false },
      { appBlockId: APP, userId: PENDING, status: 'pending', displayed: true },
      { appBlockId: APP, userId: REJECTED, status: 'rejected', displayed: true },
    ]);
  });

  it('the PUBLIC byline is accepted AND displayed only', async () => {
    expect(await listDisplayedCollaboratorUserIds(APP)).toEqual([EDITOR]);
  });

  it('🔴 the INSIDER set ignores `displayed` — hiding your byline is not a self-review bypass', async () => {
    const insiders = await listAppInsiderUserIds(APP);
    expect(insiders).toContain(OWNER);
    expect(insiders).toContain(EDITOR);
    // The whole point: HIDDEN is invisible publicly but is still an insider.
    expect(insiders).toContain(HIDDEN);
    // …and a mere invite is NOT an insider (an owner must not be able to silence a
    // critic by inviting them).
    expect(insiders).not.toContain(PENDING);
    expect(insiders).not.toContain(REJECTED);
  });
});

describe('assertAppEditAccess — the blocks.router gate', () => {
  // 🔴 This guard had NO behavioural test until a mutation sweep surfaced it: deleting
  // it left every suite green, because the only thing "covering" it was a structural
  // ledger assertion that never executes the guard. That is the unreachable-guard trap
  // in its purest form — a check whose coverage was a fact about a grep.
  const gate = (userId: number, ownerUserId: number | null = OWNER) =>
    assertAppEditAccess({ appBlockId: APP, ownerUserId, userId });

  it('the OWNER passes', async () => {
    await expect(gate(OWNER)).resolves.toBeUndefined();
  });

  it('the owner path costs NO extra query (the owner is passed in, not re-read)', async () => {
    await gate(OWNER);
    expect(mockDb.appCollaborator.findFirst).not.toHaveBeenCalled();
    expect(mockDb.appBlock.findUnique).not.toHaveBeenCalled();
  });

  it('an ACCEPTED collaborator passes', async () => {
    await expect(gate(EDITOR)).resolves.toBeUndefined();
  });

  it('a PENDING invitee is refused with THIS guard’s exact message', async () => {
    // The message is asserted verbatim so a mutant that breaks this guard dies to THIS
    // error and cannot be confused with a neighbouring gate's.
    await expect(gate(PENDING)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Not the app owner',
    });
  });

  it('a REJECTED invitee is refused', async () => {
    await expect(gate(REJECTED)).rejects.toMatchObject({ message: 'Not the app owner' });
  });

  it('a stranger is refused', async () => {
    await expect(gate(STRANGER)).rejects.toMatchObject({ message: 'Not the app owner' });
  });

  it('🔴 NO MODERATOR BYPASS — preserved from before collaborators (ledger D1)', async () => {
    // These four router procs always refused a non-owning moderator. This change must
    // not quietly grant mods a capability they did not have; the gate takes no
    // isModerator input at all, which is what makes that structural.
    await expect(gate(STRANGER)).rejects.toBeTruthy();
  });

  it('an app with NO resolvable owner is refused (fail closed), not allowed', async () => {
    await expect(gate(OWNER, null)).rejects.toMatchObject({ message: 'Not the app owner' });
  });
});

describe('safeCollaboratorQuery — INERT until the manual-apply migration lands', () => {
  it('degrades to the fallback on Prisma P2021 (table does not exist)', async () => {
    const err = Object.assign(new Error('The table does not exist'), { code: 'P2021' });
    expect(await safeCollaboratorQuery(async () => { throw err; }, 'FALLBACK')).toBe('FALLBACK');
  });

  it('degrades on the raw PG SQLSTATE 42P01 too', async () => {
    // Matching P2021 alone let a raw-path failure through; both are handled.
    const err = Object.assign(new Error('relation "app_collaborators" does not exist'), {
      code: '42P01',
    });
    expect(await safeCollaboratorQuery(async () => { throw err; }, 'FALLBACK')).toBe('FALLBACK');
  });

  it('🔴 NEGATIVE CONTROL: it does NOT swallow an unrelated error', async () => {
    // A blanket catch here would be a permanent silent-zero generator. Prove it isn't.
    const err = Object.assign(new Error('connection refused'), { code: 'P1001' });
    await expect(safeCollaboratorQuery(async () => { throw err; }, 'FALLBACK')).rejects.toThrow(
      'connection refused'
    );
  });

  it('resolveAppAccess degrades to owner-only when the seat table is absent', async () => {
    mockDb.appBlock.findUnique.mockResolvedValue({ id: APP, app: { userId: OWNER } });
    mockDb.appCollaborator.findFirst.mockRejectedValue(
      Object.assign(new Error('does not exist'), { code: 'P2021' })
    );
    // Byte-identical to the pre-change behaviour: owner yes, everyone else no —
    // and crucially NOT a 500 on every app page.
    expect((await resolveAppAccess(APP, OWNER))!.role).toBe('owner');
    expect((await resolveAppAccess(APP, EDITOR))!.role).toBeNull();
  });
});
