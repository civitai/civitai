import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * App Listing COLLABORATORS — the consolidated access predicate.
 *
 * THE PERMISSION MATRIX lives here: role × subject × expected, across
 * owner / accepted editor / PENDING editor / REJECTED editor / stranger / anon —
 * and now, crossed with the listing KIND (onsite | offsite), which is the axis the
 * block→listing re-key exists to open.
 *
 * All DB deps are mocked (no real Prisma), following the sibling block-service
 * convention: a `vi.hoisted` fake client handed to BOTH `dbRead` and `dbWrite`.
 */

const { mockDb, mockWriteDb } = vi.hoisted(() => {
  const make = () => ({
    appBlock: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      // Declared here (not assigned ad-hoc in a test) so the mock's TYPE carries it —
      // `tsconfig.json` EXCLUDES `src/**/__tests__/**`, so a green `pnpm typecheck`
      // says nothing about this file and only an explicit test typecheck catches it.
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    },
    appListing: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    },
    appCollaborator: {
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    },
  });
  // 🔴 dbRead and dbWrite are DISTINCT objects here, deliberately. A shared fake would
  // make "did this resolve read the primary?" unanswerable — the two spies would be one
  // spy, and a pool override that silently got dropped would look identical to one that
  // was honoured. Every replica-vs-primary assertion in this file depends on them being
  // two objects.
  return { mockDb: make(), mockWriteDb: make() };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockWriteDb }));

const {
  resolveAppAccess,
  resolveListingAccess,
  resolveAccessibleAppBlockIds,
  listDisplayedCollaboratorUserIds,
  listAppInsiderUserIds,
  safeCollaboratorQuery,
  assertAppEditAccess,
  capabilitiesForKind,
  listingKindSupports,
  CAPABILITIES_BY_KIND,
} = await import('~/server/services/blocks/app-access.service');

const APP = 'ab_app1';
const LISTING = 'apl_live';
const OFFSITE = 'apl_offsite';
const SHADOW = 'apl_shadow';
const OWNER = 10;
const EDITOR = 20;
const PENDING = 30;
const REJECTED = 40;
const STRANGER = 50;

/** The seat table, as the fixture DB holds it. 🔴 Keyed on the LISTING now. */
const SEATS = [
  { appListingId: LISTING, userId: EDITOR, status: 'accepted', displayed: true },
  { appListingId: LISTING, userId: PENDING, status: 'pending', displayed: true },
  { appListingId: LISTING, userId: REJECTED, status: 'rejected', displayed: true },
];

/**
 * Drive `appCollaborator.findFirst`/`findMany` from the fixture, HONOURING the `status`
 * filter.
 *
 * 🔴 Load-bearing: a mock that ignored `where.status` would make every consent test
 * pass vacuously — a pending seat would read as accepted and the suite would be green
 * against the exact bug it exists to catch. The same goes for `appListingId`: ignoring
 * it would make the shadow-hop and cross-listing tests meaningless.
 */
function wireSeats(rows = SEATS) {
  mockDb.appCollaborator.findFirst.mockImplementation(async (args: unknown): Promise<unknown> => {
    const w = (args as { where: { appListingId: string; userId: number; status?: string } }).where;
    const hit = rows.find(
      (r) =>
        r.appListingId === w.appListingId &&
        r.userId === w.userId &&
        (w.status === undefined || r.status === w.status)
    );
    return hit ? { userId: hit.userId } : null;
  });
  mockDb.appCollaborator.findMany.mockImplementation(async (args: unknown): Promise<unknown[]> => {
    const w = (args as { where: Record<string, unknown> }).where;
    return rows.filter(
      (r) =>
        (w.appListingId === undefined || r.appListingId === w.appListingId) &&
        (w.userId === undefined || r.userId === w.userId) &&
        (w.status === undefined || r.status === w.status) &&
        (w.displayed === undefined || r.displayed === w.displayed)
    );
  });
}

/** An onsite listing row as `resolveListingAccess` selects it. */
function onsiteListing(over: Record<string, unknown> = {}) {
  return {
    id: LISTING,
    userId: OWNER,
    kind: 'onsite',
    appBlockId: APP,
    revisionOfId: null,
    revisionOf: null,
    ...over,
  };
}

/** An OFF-SITE listing: no AppBlock anywhere in the chain, and that is normal. */
function offsiteListing(over: Record<string, unknown> = {}) {
  return {
    id: OFFSITE,
    userId: OWNER,
    kind: 'offsite',
    appBlockId: null,
    revisionOfId: null,
    revisionOf: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.appBlock.findUnique.mockResolvedValue({
    id: APP,
    app: { userId: OWNER },
    appListing: { id: LISTING },
  });
  mockDb.appListing.findUnique.mockResolvedValue(onsiteListing());
  wireSeats();
});

// ---------------------------------------------------------------------------
// CAPABILITIES — derived from kind, asserted as a table.
// ---------------------------------------------------------------------------

describe('capabilitiesForKind — capabilities are DERIVED, never configured', () => {
  it('onsite supports everything', () => {
    expect(capabilitiesForKind('onsite')).toEqual({
      listingContent: true,
      submitForReview: true,
      analytics: true,
      earnings: true,
      submitVersion: true,
    });
  });

  it('🔴 offsite supports content / review / analytics but NOT earnings or submit-version', () => {
    // Both `false` cells are STRUCTURAL: BlockBuzzAttribution is keyed on appBlockId,
    // and there is no bundle or Forgejo repo. They are not policy toggles.
    expect(capabilitiesForKind('offsite')).toEqual({
      listingContent: true,
      submitForReview: true,
      analytics: true,
      earnings: false,
      submitVersion: false,
    });
  });

  it('POSITIVE CONTROL: the two rows genuinely DIFFER (so neither is vacuous)', () => {
    // If both kinds mapped to the same object, every "offsite refuses X" assertion in
    // this repo would be a fact about one shared row rather than about the kind axis.
    expect(CAPABILITIES_BY_KIND.onsite).not.toEqual(CAPABILITIES_BY_KIND.offsite);
    const differing = (
      Object.keys(CAPABILITIES_BY_KIND.onsite) as Array<keyof typeof CAPABILITIES_BY_KIND.onsite>
    ).filter((k) => CAPABILITIES_BY_KIND.onsite[k] !== CAPABILITIES_BY_KIND.offsite[k]);
    expect(differing.sort()).toEqual(['earnings', 'submitVersion']);
  });

  it('🔴 an UNKNOWN kind falls back to the NARROWER (offsite) row — fail closed', () => {
    // A kind this code does not recognise must never be handed the block-only
    // capabilities. Asserted rather than assumed, because the natural mistake is to
    // default to `onsite` (the "normal" case).
    expect(listingKindSupports('something-new', 'earnings')).toBe(false);
    expect(listingKindSupports('something-new', 'submitVersion')).toBe(false);
    expect(listingKindSupports('something-new', 'listingContent')).toBe(true);
  });

  it('the table is frozen — a caller cannot mutate the capability set at runtime', () => {
    expect(Object.isFrozen(CAPABILITIES_BY_KIND)).toBe(true);
    expect(Object.isFrozen(CAPABILITIES_BY_KIND.offsite)).toBe(true);
  });
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
      expect(access!.appListingId).toBe(LISTING);
    });
  }

  it('POSITIVE CONTROL: the seat mock honours the status filter', async () => {
    // If this were not true, the PENDING/REJECTED rows above would pass vacuously.
    const asAccepted = await mockDb.appCollaborator.findFirst({
      where: { appListingId: LISTING, userId: PENDING, status: 'accepted' },
    });
    const asAny = await mockDb.appCollaborator.findFirst({
      where: { appListingId: LISTING, userId: PENDING },
    });
    expect(asAccepted).toBeNull();
    expect(asAny).toEqual({ userId: PENDING });
  });

  it('🔴 the seat is looked up under the BLOCK’S LISTING id, not the block id', async () => {
    // The whole re-key in one assertion. A resolver that kept passing `appBlockId` here
    // would find nothing in the fixture and silently demote every editor to `null`.
    await resolveAppAccess(APP, EDITOR);
    expect(mockDb.appCollaborator.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { appListingId: LISTING, userId: EDITOR, status: 'accepted' },
      })
    );
  });

  it('a block with NO listing yet resolves owner-or-nothing (nothing to seat on)', async () => {
    mockDb.appBlock.findUnique.mockResolvedValue({
      id: APP,
      app: { userId: OWNER },
      appListing: null,
    });
    expect((await resolveAppAccess(APP, OWNER))!.role).toBe('owner');
    const editor = await resolveAppAccess(APP, EDITOR);
    expect(editor!.role).toBeNull();
    expect(editor!.appListingId).toBeNull();
    // …and it did not waste a seat query it could not key.
    expect(mockDb.appCollaborator.findFirst).not.toHaveBeenCalled();
  });

  it('a missing AppBlock resolves null (not a role)', async () => {
    mockDb.appBlock.findUnique.mockResolvedValue(null);
    expect(await resolveAppAccess(APP, OWNER)).toBeNull();
  });

  it('an AppBlock with no resolvable owner resolves null — fail closed', async () => {
    // A dangling app_id: an app nobody owns is an app nobody may edit.
    mockDb.appBlock.findUnique.mockResolvedValue({ id: APP, app: null, appListing: null });
    expect(await resolveAppAccess(APP, OWNER)).toBeNull();
  });
});

describe('resolveListingAccess — role × KIND', () => {
  function wireListing(row: Record<string, unknown> | null) {
    mockDb.appListing.findUnique.mockResolvedValue(row);
  }

  /**
   * 🔴 THE KIND AXIS. Every cell is the same for onsite and offsite — that identity IS
   * the feature. Before the re-key the offsite column was `owner`/`null` only, because a
   * seat had nowhere to live.
   */
  const ROLES: Array<[string, number | null, 'owner' | 'editor' | null]> = [
    ['owner', OWNER, 'owner'],
    ['accepted editor', EDITOR, 'editor'],
    ['PENDING editor', PENDING, null],
    ['REJECTED editor', REJECTED, null],
    ['stranger', STRANGER, null],
    ['anonymous', null, null],
  ];

  for (const [kind, listingId, row] of [
    ['onsite', LISTING, onsiteListing] as const,
    ['offsite', OFFSITE, offsiteListing] as const,
  ]) {
    describe(`kind=${kind}`, () => {
      beforeEach(() => {
        wireListing(row());
        wireSeats(SEATS.map((s) => ({ ...s, appListingId: listingId })));
      });

      for (const [label, userId, expected] of ROLES) {
        it(`${label} → role ${expected ?? 'null'}`, async () => {
          const access = await resolveListingAccess(listingId, userId);
          expect(access).not.toBeNull();
          expect(access!.role).toBe(expected);
          expect(access!.kind).toBe(kind);
          expect(access!.seatListingId).toBe(listingId);
        });
      }

      it(`reports appBlockId ${kind === 'onsite' ? 'APP' : 'null'}`, async () => {
        const access = await resolveListingAccess(listingId, OWNER);
        expect(access!.appBlockId).toBe(kind === 'onsite' ? APP : null);
      });
    });
  }

  it('🔴 an OFFSITE listing can now hold an editor — the whole point of the re-key', async () => {
    // Stated as its own case because the PRE-change behaviour was `null` here, for every
    // offsite listing, unconditionally. This is the cell that flipped.
    wireListing(offsiteListing());
    wireSeats([{ appListingId: OFFSITE, userId: EDITOR, status: 'accepted', displayed: true }]);
    expect((await resolveListingAccess(OFFSITE, EDITOR))!.role).toBe('editor');
  });

  it('🔴 SHADOW-AWARE: an editor keeps access to a shadow revision (appBlockId is NULL on it)', async () => {
    // A shadow carries appBlockId: null by construction (`appBlockId` is @unique and
    // stays on the parent). Without the revisionOf hop, an editor would LOSE access the
    // instant their first media edit minted the shadow — i.e. the feature would break
    // on its own second click. Now it matters twice over: no seat can EXIST on a shadow.
    wireListing({
      id: SHADOW,
      userId: OWNER,
      kind: 'onsite',
      appBlockId: null,
      revisionOfId: LISTING,
      revisionOf: { id: LISTING, kind: 'onsite', appBlockId: APP },
    });
    const access = await resolveListingAccess(SHADOW, EDITOR);
    expect(access!.seatListingId).toBe(LISTING);
    expect(access!.appBlockId).toBe(APP);
    expect(access!.role).toBe('editor');
    // 🔴 The seat was read under the PARENT id. A resolver that looked it up under the
    // shadow id would find nothing — and would also be looking somewhere a seat can
    // never legitimately exist.
    expect(mockDb.appCollaborator.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { appListingId: LISTING, userId: EDITOR, status: 'accepted' },
      })
    );
  });

  it('🔴 a shadow of an OFFSITE parent reports the PARENT’s kind, not a guess', async () => {
    // Reading kind/appBlockId off the shadow would make every in-flight revision look
    // like a different kind than its parent.
    wireListing({
      id: SHADOW,
      userId: OWNER,
      kind: 'offsite',
      appBlockId: null,
      revisionOfId: OFFSITE,
      revisionOf: { id: OFFSITE, kind: 'offsite', appBlockId: null },
    });
    const access = await resolveListingAccess(SHADOW, OWNER);
    expect(access!.kind).toBe('offsite');
    expect(access!.seatListingId).toBe(OFFSITE);
    expect(access!.appBlockId).toBeNull();
  });

  it('a missing listing resolves null', async () => {
    wireListing(null);
    expect(await resolveListingAccess(LISTING, OWNER)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 🔴 THE POOL OVERRIDE — the editor's first media edit under replica lag.
  // -------------------------------------------------------------------------

  describe('🔴 the `db` pool override reaches the SEAT lookup, not just the listing lookup', () => {
    /**
     * THE SCENARIO, stated so the assertions are readable as behaviour:
     *
     * `app-listing-assets::loadOwnedListing` takes a `dbWrite` override so the OWNER's
     * FIRST edit does not 404 off a lagging replica — the shadow revision was INSERTed
     * milliseconds earlier. An EDITOR cannot benefit from that on the owner branch,
     * because a shadow's `userId` is the PARENT OWNER's: the editor ALWAYS falls through
     * to the collaborator check. If that check reads the replica, the identical lag that
     * used to 404 the owner now 403s the editor instead of resolving their seat.
     *
     * So the primary must answer BOTH reads. `dbRead` here is wired to know NOTHING —
     * it is the lagging replica — which is what makes a dropped override observable as a
     * denial rather than as an equivalent answer from a second identical fixture.
     */
    const LAGGING = () => {
      mockDb.appListing.findUnique.mockResolvedValue(null);
      mockDb.appCollaborator.findFirst.mockResolvedValue(null);
    };

    beforeEach(() => {
      LAGGING();
      mockWriteDb.appListing.findUnique.mockResolvedValue({
        id: SHADOW,
        userId: OWNER,
        kind: 'onsite',
        appBlockId: null,
        revisionOfId: LISTING,
        revisionOf: { id: LISTING, kind: 'onsite', appBlockId: APP },
      });
      mockWriteDb.appCollaborator.findFirst.mockImplementation(async (args: unknown) => {
        const w = (args as { where: { userId: number; status?: string } }).where;
        return w.userId === EDITOR && w.status === 'accepted' ? { userId: EDITOR } : null;
      });
    });

    it('the editor resolves to `editor` when the PRIMARY is passed', async () => {
      const access = await resolveListingAccess(SHADOW, EDITOR, mockWriteDb as never);
      expect(access!.role).toBe('editor');
      // Both reads went to the primary…
      expect(mockWriteDb.appListing.findUnique).toHaveBeenCalledOnce();
      expect(mockWriteDb.appCollaborator.findFirst).toHaveBeenCalledOnce();
      // …and NEITHER touched the replica. This is the assertion that dies when the
      // override is threaded to the listing load but dropped before the seat lookup —
      // the exact shape of the bug.
      expect(mockDb.appListing.findUnique).not.toHaveBeenCalled();
      expect(mockDb.appCollaborator.findFirst).not.toHaveBeenCalled();
    });

    it('🔴 NEGATIVE CONTROL: the SAME call off the lagging replica denies', async () => {
      // Without this, the test above is a fact about a mock that answers either way.
      // The replica knows nothing, so the default (no override) must fail to resolve —
      // which is precisely the 403 the override exists to prevent.
      expect(await resolveListingAccess(SHADOW, EDITOR)).toBeNull();
    });

    it('POSITIVE CONTROL: the two pools are distinct objects with independent spies', () => {
      // A shared fake would make every assertion above vacuous.
      expect(mockWriteDb).not.toBe(mockDb);
      expect(mockWriteDb.appCollaborator.findFirst).not.toBe(mockDb.appCollaborator.findFirst);
    });
  });
});

/**
 * 🔴 THE OWNER AXIS — `resolveListingAccess.ownerUserId` must be the CANONICAL owner.
 *
 * For an ON-SITE listing the owner is `OauthClient.userId`, reached as
 * `AppListing.appBlock.app.userId`. `AppListing.userId` is a DENORMALIZED COPY, and this
 * feature's own code can leave it stale on purpose: `acceptTransfer` step 3 is unguarded
 * for onsite and treats a 0-count as an accepted desync
 * (`app-ownership-transfer.service.ts`), so a listing whose OauthClient moved but whose
 * column did not is a state the code can produce itself.
 *
 * Reading the copy inverts the gate in BOTH directions at once, which is why the fixture
 * below pins both: the REAL owner is refused on their own listing, and the STALE user is
 * admitted as owner — with the roster (including `displayed:false` seats, `invitedBy` and
 * the timestamps) and the pending-transfer read behind that gate.
 */
describe('🔴 resolveListingAccess — ownerUserId is CANONICAL, not the denormalized column', () => {
  /** The real owner (OauthClient.userId) and the stale name left in the column. */
  const REAL_OWNER = 111;
  const STALE_OWNER = 222;

  /** An onsite listing whose denormalized `userId` DISAGREES with its OauthClient. */
  function driftedOnsite(over: Record<string, unknown> = {}) {
    return {
      id: LISTING,
      userId: STALE_OWNER,
      kind: 'onsite',
      appBlockId: APP,
      revisionOfId: null,
      revisionOf: null,
      appBlock: { app: { userId: REAL_OWNER } },
      ...over,
    };
  }

  it('POSITIVE CONTROL: with no drift, both sources agree and the owner resolves', async () => {
    // If this failed, every assertion below would be about a broken fixture rather than
    // about the resolution rule.
    mockDb.appListing.findUnique.mockResolvedValue({
      ...driftedOnsite(),
      userId: REAL_OWNER,
    });
    const res = await resolveListingAccess(LISTING, REAL_OWNER);
    expect(res?.ownerUserId).toBe(REAL_OWNER);
    expect(res?.role).toBe('owner');
  });

  it('🔴 the REAL owner is `owner` even though the column names someone else', async () => {
    mockDb.appListing.findUnique.mockResolvedValue(driftedOnsite());
    const res = await resolveListingAccess(LISTING, REAL_OWNER);
    expect(res?.ownerUserId).toBe(REAL_OWNER);
    expect(res?.role).toBe('owner');
  });

  it('🔴 the STALE user named by the column is NOT the owner', async () => {
    // The other half, and the one that matters for the roster leak: whoever the stale
    // row names must not be handed owner-level reads on someone else's listing.
    mockDb.appListing.findUnique.mockResolvedValue(driftedOnsite());
    const res = await resolveListingAccess(LISTING, STALE_OWNER);
    expect(res?.ownerUserId).toBe(REAL_OWNER);
    expect(res?.role).toBeNull();
  });

  it('an OFFSITE listing keeps using the column — there is no OauthClient in the chain', async () => {
    // The fallback is not a lenience; for offsite the column IS the owner, so this pins
    // that the fix did not quietly break the kind it does not apply to.
    mockDb.appListing.findUnique.mockResolvedValue({ ...offsiteListing(), appBlock: null });
    const res = await resolveListingAccess(OFFSITE, OWNER);
    expect(res?.ownerUserId).toBe(OWNER);
    expect(res?.role).toBe('owner');
  });

  it('an onsite block with a DANGLING app_id falls back to the column', async () => {
    // `appBlock.app` is null when `app_id` points at nothing. Falling through to the
    // column is the only owner signal left; the alternative (null) would lock the
    // listing's real owner out of it entirely.
    mockDb.appListing.findUnique.mockResolvedValue(driftedOnsite({ appBlock: { app: null } }));
    const res = await resolveListingAccess(LISTING, STALE_OWNER);
    expect(res?.ownerUserId).toBe(STALE_OWNER);
    expect(res?.role).toBe('owner');
  });

  it('🔴 a SHADOW resolves the owner from its PARENT’s block, not from its own row', async () => {
    // A shadow carries `appBlockId: null` by construction, so reading the block off the
    // shadow would silently fall back to the column for every in-flight revision — i.e.
    // re-introduce the whole defect on exactly the rows an editor is working on.
    mockDb.appListing.findUnique.mockResolvedValue({
      id: SHADOW,
      userId: STALE_OWNER,
      kind: 'onsite',
      appBlockId: null,
      revisionOfId: LISTING,
      appBlock: null,
      revisionOf: {
        id: LISTING,
        kind: 'onsite',
        appBlockId: APP,
        appBlock: { app: { userId: REAL_OWNER } },
      },
    });
    const res = await resolveListingAccess(SHADOW, REAL_OWNER);
    expect(res?.seatListingId).toBe(LISTING);
    expect(res?.ownerUserId).toBe(REAL_OWNER);
    expect(res?.role).toBe('owner');
    expect((await resolveListingAccess(SHADOW, STALE_OWNER))?.role).toBeNull();
  });

  it('🔴 STRUCTURAL: the listing query SELECTS the canonical owner on both the row and its parent', async () => {
    // A behavioural assertion alone cannot tell "resolved from the block" from "the fake
    // happened to return the same number"; this pins that the column is actually asked
    // for, on both sides of the shadow hop.
    mockDb.appListing.findUnique.mockResolvedValue(driftedOnsite());
    await resolveListingAccess(LISTING, REAL_OWNER);
    const args = mockDb.appListing.findUnique.mock.calls[0][0] as {
      select: {
        appBlock?: { select: { app: { select: { userId: boolean } } } };
        revisionOf?: {
          select: { appBlock?: { select: { app: { select: { userId: boolean } } } } };
        };
      };
    };
    expect(args.select.appBlock?.select.app.select.userId).toBe(true);
    expect(args.select.revisionOf?.select.appBlock?.select.app.select.userId).toBe(true);
  });
});

describe('resolveAccessibleAppBlockIds', () => {
  const OTHER = 'ab_app2';
  const OTHER_LISTING = 'apl_other';
  /**
   * 🔴 THE SHAPE WHERE "offsite" AND "has no block" DISAGREE — an OFF-SITE listing that
   * DOES carry a backing AppBlock. It is not hypothetical: `mapAppBlockToListing` mints
   * exactly this whenever the source AppBlock has an `externalUrl`
   * (`kind: isOffsite ? 'offsite' : 'onsite'` with `appBlockId: ab.id` unconditionally),
   * and the mod proc `backfillAppListings` reaches it. `schema.full.prisma` says in as
   * many words to discriminate on `kind`, never on `appBlockId` nullness.
   *
   * Production count today is 0 (measured 2026-08-11: offsite 5 rows, 0 with a block),
   * so every assertion using this fixture is PREVENTION — but it guards the input to a
   * money read, so a fixture that cannot express the shape cannot certify the gate.
   */
  const OFFSITE_WITH_BLOCK = 'apl_offsite_with_block';
  const OFFSITE_BLOCK = 'ab_offsiteBlock';

  /**
   * Resolve seated LISTING ids → their backing blocks, honouring BOTH filters the
   * service sends: `kind` and the `appBlockId` not-null.
   *
   * 🔴 The fake must honour `kind` INDEPENDENTLY of `appBlockId`, or the two predicates
   * collapse into one here and the disagreement case becomes untestable through it.
   */
  function wireSeatListings(rows: Array<{ id: string; kind: string; appBlockId: string | null }>) {
    mockDb.appListing.findMany.mockImplementation(async (args: unknown): Promise<unknown[]> => {
      const w = (args as { where: { id: { in: string[] }; kind?: string; appBlockId?: unknown } })
        .where;
      return rows
        .filter((r) => w.id.in.includes(r.id))
        .filter((r) => (w.kind === undefined ? true : r.kind === w.kind))
        .filter((r) => (w.appBlockId === undefined ? true : r.appBlockId != null))
        .map((r) => ({ appBlockId: r.appBlockId }));
    });
  }

  beforeEach(() => {
    wireSeatListings([
      { id: LISTING, kind: 'onsite', appBlockId: APP },
      { id: OTHER_LISTING, kind: 'onsite', appBlockId: OTHER },
      { id: OFFSITE, kind: 'offsite', appBlockId: null },
      { id: OFFSITE_WITH_BLOCK, kind: 'offsite', appBlockId: OFFSITE_BLOCK },
    ]);
  });

  describe('🔴 the discriminator is `kind`, NOT `appBlockId IS NULL`', () => {
    it('an OFFSITE seat on a listing that HAS a block still contributes NOTHING', async () => {
      // The `appBlockId: { not: null }` predicate does not fire here — the row has a
      // block. Only the `kind: 'onsite'` predicate can refuse it, so this case is the
      // ONLY one that can kill a mutant which drops that predicate.
      mockDb.appBlock.findMany.mockResolvedValue([]);
      wireSeats([
        { appListingId: OFFSITE_WITH_BLOCK, userId: EDITOR, status: 'accepted', displayed: true },
      ]);
      const res = await resolveAccessibleAppBlockIds(EDITOR);
      expect(res.editorIds).toEqual([]);
      expect(res.allIds).toEqual([]);
      // Named explicitly so the failure message says WHICH id leaked.
      expect(res.allIds).not.toContain(OFFSITE_BLOCK);
    });

    it('🔴 POSITIVE CONTROL: the SAME block id DOES flow through when the kind is onsite', async () => {
      // Without this, "contributes nothing" is indistinguishable from a fixture whose
      // block id was never reachable at all — the same zero, two causes.
      mockDb.appBlock.findMany.mockResolvedValue([]);
      wireSeatListings([{ id: OFFSITE_WITH_BLOCK, kind: 'onsite', appBlockId: OFFSITE_BLOCK }]);
      wireSeats([
        { appListingId: OFFSITE_WITH_BLOCK, userId: EDITOR, status: 'accepted', displayed: true },
      ]);
      expect((await resolveAccessibleAppBlockIds(EDITOR)).allIds).toEqual([OFFSITE_BLOCK]);
    });

    it('🔴 STRUCTURAL: the listing query carries `kind: onsite` as well as the not-null', async () => {
      // The behavioural case above is served by a fake; this pins the predicate that is
      // actually sent to Postgres, so a mutant that moves the filter into memory (where
      // the next refactor drops it) is still visible.
      mockDb.appBlock.findMany.mockResolvedValue([]);
      wireSeats([{ appListingId: LISTING, userId: EDITOR, status: 'accepted', displayed: true }]);
      await resolveAccessibleAppBlockIds(EDITOR);
      const args = mockDb.appListing.findMany.mock.calls[0][0] as {
        where: { kind?: unknown; appBlockId?: unknown };
      };
      expect(args.where.kind, 'the KIND discriminator must be in the WHERE').toBe('onsite');
      expect(args.where.appBlockId).toEqual({ not: null });
    });

    it('a MIXED portfolio keeps only the onsite seat of THREE', async () => {
      // onsite+block (kept), offsite+no-block (dropped by either predicate),
      // offsite+block (dropped by KIND alone).
      mockDb.appBlock.findMany.mockResolvedValue([]);
      wireSeats([
        { appListingId: LISTING, userId: EDITOR, status: 'accepted', displayed: true },
        { appListingId: OFFSITE, userId: EDITOR, status: 'accepted', displayed: true },
        { appListingId: OFFSITE_WITH_BLOCK, userId: EDITOR, status: 'accepted', displayed: true },
      ]);
      expect((await resolveAccessibleAppBlockIds(EDITOR)).allIds).toEqual([APP]);
    });
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
    // The editor owns nothing; their seat is on LISTING (→ APP) only. OTHER must not
    // appear.
    mockDb.appBlock.findMany.mockResolvedValue([]);
    wireSeats([{ appListingId: LISTING, userId: EDITOR, status: 'accepted', displayed: true }]);
    const res = await resolveAccessibleAppBlockIds(EDITOR);
    expect(res.ownedIds).toEqual([]);
    expect(res.editorIds).toEqual([APP]);
    expect(res.allIds).toEqual([APP]);
    expect(res.allIds).not.toContain(OTHER);
  });

  it('a PENDING seat contributes nothing', async () => {
    mockDb.appBlock.findMany.mockResolvedValue([]);
    wireSeats([{ appListingId: LISTING, userId: PENDING, status: 'pending', displayed: true }]);
    expect((await resolveAccessibleAppBlockIds(PENDING)).allIds).toEqual([]);
  });

  it('🔴 an OFFSITE seat contributes NOTHING to a BLOCK-id set — it has no block', async () => {
    // This is the `earnings: false` capability cell expressed as data: an offsite seat
    // must not widen a block-keyed money/analytics query by even one id.
    mockDb.appBlock.findMany.mockResolvedValue([]);
    wireSeats([{ appListingId: OFFSITE, userId: EDITOR, status: 'accepted', displayed: true }]);
    const res = await resolveAccessibleAppBlockIds(EDITOR);
    expect(res.editorIds).toEqual([]);
    expect(res.allIds).toEqual([]);
    expect(res.allIds).not.toContain(null);
  });

  /**
   * 🔴 TWO REDUNDANT GUARDS, SO EACH NEEDS ITS OWN KILLING CASE.
   *
   * The null-block exclusion is written twice: once as `appBlockId: { not: null }` in
   * the LISTING QUERY, and once as `!!id` in the mapping that follows. A mutation sweep
   * found the pair out — removing the query filter changed NOTHING observable, because
   * the `!!id` filter caught the nulls anyway, and the mutant SURVIVED. That is exactly
   * the redundant-guard trap: "a test went red" is not the same as "this guard is
   * tested", and with two guards protecting one property, an output-only assertion can
   * only ever be evidence about whichever one happens to run last.
   *
   * So the two are pinned separately: the query filter STRUCTURALLY (it must be in the
   * WHERE), and the mapping filter BEHAVIOURALLY (against a fake that deliberately
   * ignores the WHERE, i.e. a DB that hands back a null).
   */
  it('🔴 GUARD 1/2 (structural): the listing query itself excludes null-block rows', async () => {
    mockDb.appBlock.findMany.mockResolvedValue([]);
    wireSeats([{ appListingId: LISTING, userId: EDITOR, status: 'accepted', displayed: true }]);
    await resolveAccessibleAppBlockIds(EDITOR);
    const args = mockDb.appListing.findMany.mock.calls[0][0] as {
      where: { id: { in: string[] }; appBlockId?: unknown };
    };
    expect(args.where.id.in).toEqual([LISTING]);
    // Not merely "some filter": the exact predicate. Dropping it makes the query pull
    // rows it must then throw away, and leaves the null-exclusion resting on one
    // in-memory `!!id` that a later refactor has no reason to keep.
    expect(args.where.appBlockId, 'the null-block exclusion must be in the WHERE').toEqual({
      not: null,
    });
  });

  it('🔴 GUARD 2/2 (behavioural): a null that reaches memory anyway is still dropped', async () => {
    // The fake here IGNORES the `appBlockId: { not: null }` filter on purpose — it is
    // standing in for a DB that returned a null row. Only the in-memory `!!id` can save
    // this case, so a mutant that removes THAT guard dies here and nowhere else.
    mockDb.appBlock.findMany.mockResolvedValue([]);
    wireSeats([
      { appListingId: LISTING, userId: EDITOR, status: 'accepted', displayed: true },
      { appListingId: OFFSITE, userId: EDITOR, status: 'accepted', displayed: true },
    ]);
    mockDb.appListing.findMany.mockResolvedValue([{ appBlockId: APP }, { appBlockId: null }]);
    const res = await resolveAccessibleAppBlockIds(EDITOR);
    expect(res.allIds).toEqual([APP]);
    expect(res.allIds).not.toContain(null);
    expect(res.editorIds).not.toContain(null);
  });

  it('🔴 a MIXED portfolio keeps the onsite seat and drops only the offsite one', async () => {
    // The positive half of the case above: proving the filter removes the offsite id
    // WITHOUT removing everything (which a broken filter would also do, silently).
    mockDb.appBlock.findMany.mockResolvedValue([]);
    wireSeats([
      { appListingId: LISTING, userId: EDITOR, status: 'accepted', displayed: true },
      { appListingId: OFFSITE, userId: EDITOR, status: 'accepted', displayed: true },
    ]);
    expect((await resolveAccessibleAppBlockIds(EDITOR)).allIds).toEqual([APP]);
  });

  it('owned and editor sets are disjoint — an owner who also holds a seat counts once', async () => {
    mockDb.appBlock.findMany.mockResolvedValue([{ id: APP }]);
    wireSeats([{ appListingId: LISTING, userId: OWNER, status: 'accepted', displayed: true }]);
    const res = await resolveAccessibleAppBlockIds(OWNER);
    expect(res.editorIds).toEqual([]);
    expect(res.allIds).toEqual([APP]);
  });

  it('no seats at all ⇒ no listing round trip', async () => {
    mockDb.appBlock.findMany.mockResolvedValue([{ id: APP }]);
    wireSeats([]);
    await resolveAccessibleAppBlockIds(OWNER);
    expect(mockDb.appListing.findMany).not.toHaveBeenCalled();
  });
});

describe('listDisplayedCollaboratorUserIds vs listAppInsiderUserIds — the displayed asymmetry', () => {
  const HIDDEN = 60;

  beforeEach(() => {
    mockDb.appBlock.findUnique.mockResolvedValue({
      id: APP,
      app: { userId: OWNER },
      appListing: { id: LISTING },
    });
    wireSeats([
      { appListingId: LISTING, userId: EDITOR, status: 'accepted', displayed: true },
      { appListingId: LISTING, userId: HIDDEN, status: 'accepted', displayed: false },
      { appListingId: LISTING, userId: PENDING, status: 'pending', displayed: true },
      { appListingId: LISTING, userId: REJECTED, status: 'rejected', displayed: true },
    ]);
  });

  it('the PUBLIC byline is accepted AND displayed only', async () => {
    expect(await listDisplayedCollaboratorUserIds(LISTING)).toEqual([EDITOR]);
  });

  it('🔴 the PUBLIC byline works for an OFFSITE listing — it is listing-keyed', async () => {
    // Before the re-key this read took an appBlockId, so an offsite listing's byline was
    // structurally always empty. Nothing about the query mentions a block now.
    wireSeats([
      { appListingId: OFFSITE, userId: EDITOR, status: 'accepted', displayed: true },
      { appListingId: OFFSITE, userId: HIDDEN, status: 'accepted', displayed: false },
    ]);
    expect(await listDisplayedCollaboratorUserIds(OFFSITE)).toEqual([EDITOR]);
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

  it('the insider set is the OWNER alone when the block has no listing', async () => {
    mockDb.appBlock.findUnique.mockResolvedValue({
      id: APP,
      app: { userId: OWNER },
      appListing: null,
    });
    expect(await listAppInsiderUserIds(APP)).toEqual([OWNER]);
  });
});

describe('assertAppEditAccess — the blocks.router gate', () => {
  // 🔴 This guard had NO behavioural test until a mutation sweep surfaced it: deleting
  // it left every suite green, because the only thing "covering" it was a structural
  // ledger assertion that never executes the guard. That is the unreachable-guard trap
  // in its purest form — a check whose coverage was a fact about a grep.
  const gate = (userId: number, ownerUserId: number | null = OWNER) =>
    assertAppEditAccess({ appBlockId: APP, ownerUserId, userId });

  beforeEach(() => {
    // The block→listing hop the non-owner path now makes.
    mockDb.appListing.findUnique.mockResolvedValue({ id: LISTING });
  });

  it('the OWNER passes', async () => {
    await expect(gate(OWNER)).resolves.toBeUndefined();
  });

  it('the owner path costs NO extra query (the owner is passed in, not re-read)', async () => {
    await gate(OWNER);
    expect(mockDb.appCollaborator.findFirst).not.toHaveBeenCalled();
    expect(mockDb.appBlock.findUnique).not.toHaveBeenCalled();
    // …including the block→listing hop, which is paid only when a seat could matter.
    expect(mockDb.appListing.findUnique).not.toHaveBeenCalled();
  });

  it('an ACCEPTED collaborator passes', async () => {
    await expect(gate(EDITOR)).resolves.toBeUndefined();
  });

  it('🔴 the seat is resolved via the block’s LISTING', async () => {
    await gate(EDITOR);
    expect(mockDb.appListing.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { appBlockId: APP } })
    );
    expect(mockDb.appCollaborator.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { appListingId: LISTING, userId: EDITOR, status: 'accepted' },
      })
    );
  });

  it('a block with NO listing refuses even a would-be editor — fail closed', async () => {
    mockDb.appListing.findUnique.mockResolvedValue(null);
    await expect(gate(EDITOR)).rejects.toMatchObject({ message: 'Not the app owner' });
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
    expect(
      await safeCollaboratorQuery(async () => {
        throw err;
      }, 'FALLBACK')
    ).toBe('FALLBACK');
  });

  it('degrades on the raw PG SQLSTATE 42P01 too', async () => {
    // Matching P2021 alone let a raw-path failure through; both are handled.
    const err = Object.assign(new Error('relation "app_collaborators" does not exist'), {
      code: '42P01',
    });
    expect(
      await safeCollaboratorQuery(async () => {
        throw err;
      }, 'FALLBACK')
    ).toBe('FALLBACK');
  });

  it('🔴 NEGATIVE CONTROL: it does NOT swallow an unrelated error', async () => {
    // A blanket catch here would be a permanent silent-zero generator. Prove it isn't.
    const err = Object.assign(new Error('connection refused'), { code: 'P1001' });
    await expect(
      safeCollaboratorQuery(async () => {
        throw err;
      }, 'FALLBACK')
    ).rejects.toThrow('connection refused');
  });

  it('the message branch still degrades when the driver attached NO code (relation missing)', async () => {
    // The reason the message branch exists at all: some driver paths surface the raw PG
    // text with the SQLSTATE unclassified. This must keep working after the narrowing.
    const err = new Error('relation "app_collaborators" does not exist');
    expect(
      await safeCollaboratorQuery(async () => {
        throw err;
      }, 'FALLBACK')
    ).toBe('FALLBACK');
  });

  it('…and on Prisma’s own P2021 wording with no code attached', async () => {
    const err = new Error(
      'The table `public.app_collaborators` does not exist in the current database.'
    );
    expect(
      await safeCollaboratorQuery(async () => {
        throw err;
      }, 'FALLBACK')
    ).toBe('FALLBACK');
  });

  describe('🔴 a HALF-APPLIED manual migration must NOT be swallowed', () => {
    // The blast radius: migrations here are applied BY HAND (datapacket-talos DB rule
    // #8), so "the table exists but a column is missing" is a routine intermediate state
    // — and it is the one state where degrading to "no collaborators" is worst, because
    // it is silent and permanent. A `/does not exist/` message test cannot tell the two
    // apart; these cases are the mutants that prove it no longer tries.
    //
    // 🔴 THE RE-KEY MAKES THIS CASE ROUTINE RATHER THAN THEORETICAL. Between deploying
    // this code and applying the re-key migration, the OLD block-keyed tables still
    // exist, so every read fails with `column "app_listing_id" does not exist` — the
    // FIRST case below, verbatim. It must surface, not degrade.
    const COLUMN_ERRORS: Array<[string, string]> = [
      [
        '🔴 the re-key deploy window: the table exists, the new column does not',
        'column "app_listing_id" does not exist',
      ],
      ['a bare missing column', 'column "displayed" does not exist'],
      [
        'PG 42703, which NAMES a relation and would match a relation-only regex',
        'column "invited_by" of relation "app_collaborators" does not exist',
      ],
      [
        'the Prisma-wrapped form',
        'Invalid `prisma.appCollaborator.findMany()` invocation: The column `app_collaborators.displayed` does not exist in the current database.',
      ],
    ];

    for (const [label, message] of COLUMN_ERRORS) {
      it(`propagates: ${label}`, async () => {
        await expect(
          safeCollaboratorQuery(async () => {
            throw new Error(message);
          }, 'FALLBACK')
        ).rejects.toThrow(message);
      });
    }

    /**
     * 🔴 THESE EXIST BECAUSE OF REDUNDANT-GUARD COVERAGE, and finding that out is why
     * they exist at all.
     *
     * The narrowing is TWO clauses: a `\bcolumns?\b` veto, and a final regex that
     * requires the missing object to be named as a RELATION or TABLE. Every case above
     * mentions a column, so the veto alone kills them — which means a mutant that
     * broadened the FINAL regex straight back to `/does not exist/` SURVIVED the first
     * sweep: the veto caught the column cases and nothing else was asking.
     *
     * A `does not exist` message can name plenty of objects that are not columns, and
     * these two are the ones a hand-applied migration actually produces: the enum TYPE a
     * migration creates before its table (42704), and the SCHEMA it was pointed at
     * (3F000). Neither contains the word "column", so ONLY the object-name clause can
     * refuse them — which is what makes these kills attributable to that clause rather
     * than to its neighbour.
     */
    const NON_COLUMN_ERRORS: Array<[string, string]> = [
      [
        'PG 42704 — the enum TYPE a migration creates before its table',
        'type "app_collaborator_status" does not exist',
      ],
      ['PG 3F000 — the schema itself', 'schema "public_v2" does not exist'],
    ];

    for (const [label, message] of NON_COLUMN_ERRORS) {
      it(`🔴 propagates (object-name clause, no column word to lean on): ${label}`, async () => {
        await expect(
          safeCollaboratorQuery(async () => {
            throw new Error(message);
          }, 'FALLBACK')
        ).rejects.toThrow(message);
      });
    }

    it('POSITIVE CONTROL: those same messages differ from a real missing TABLE only in the object named', async () => {
      // Proves the assertions above are about the OBJECT NAME and not about some other
      // incidental difference in the string: swap `type`/`schema` for `relation` and the
      // very same sentence shape IS degraded.
      expect(
        await safeCollaboratorQuery(async () => {
          throw new Error('relation "app_collaborator_status" does not exist');
        }, 'FALLBACK')
      ).toBe('FALLBACK');
    });

    it('🔴 MUTANT: broadening the message test to `not found` must not swallow either', async () => {
      // The surviving P5 mutant. `not found` is Prisma's wording for a missing RECORD
      // (P2025) — a normal application-level failure that must never read as "the
      // feature is not deployed yet".
      await expect(
        safeCollaboratorQuery(async () => {
          throw new Error(
            'An operation failed because it depends on one or more records that were required but not found.'
          );
        }, 'FALLBACK')
      ).rejects.toThrow('not found');
    });

    it('a non-string message is not a missing table', async () => {
      await expect(
        safeCollaboratorQuery(async () => {
          throw Object.assign(new Error('x'), { message: undefined, code: 'P1017' });
        }, 'FALLBACK')
      ).rejects.toBeTruthy();
    });
  });

  it('resolveAppAccess degrades to owner-only when the seat table is absent', async () => {
    mockDb.appBlock.findUnique.mockResolvedValue({
      id: APP,
      app: { userId: OWNER },
      appListing: { id: LISTING },
    });
    mockDb.appCollaborator.findFirst.mockRejectedValue(
      Object.assign(new Error('does not exist'), { code: 'P2021' })
    );
    // Byte-identical to the pre-change behaviour: owner yes, everyone else no —
    // and crucially NOT a 500 on every app page.
    expect((await resolveAppAccess(APP, OWNER))!.role).toBe('owner');
    expect((await resolveAppAccess(APP, EDITOR))!.role).toBeNull();
  });
});
