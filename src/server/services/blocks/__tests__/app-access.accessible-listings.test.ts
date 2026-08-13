import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two MISSING BACKEND READS the collaborator UI needs:
 * `resolveAccessibleListingIds` / `listMyAppListings` (the ownership-OR-seat set) and
 * `getAppListingAuthoringContext` (its single-listing form).
 *
 * 🔴 WHY THEY ARE NOT A REFACTOR OF SOMETHING EXISTING, pinned here as behaviour:
 *   - `resolveAccessibleAppBlockIds` returns APP BLOCK ids, so an off-site listing is
 *     structurally unrepresentable in it; and
 *   - `listMySubmissions` is scoped to a publish request's `submittedByUserId`, so it
 *     answers neither ownership nor seats.
 *
 * DB deps are mocked following the sibling convention (a `vi.hoisted` fake handed to
 * `dbRead`/`dbWrite`); no real Prisma.
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
  });
  return { mockDb: make(), mockWriteDb: make() };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockWriteDb }));

const {
  resolveAccessibleListingIds,
  listMyAppListings,
  getAppListingAuthoringContext,
  listingIdForAppBlock,
  MY_APP_LISTINGS_LIMIT,
} = await import('~/server/services/blocks/app-access.service');

const OWNER = 10;
const EDITOR = 20;
const STRANGER = 30;

type ListingRow = {
  id: string;
  slug?: string;
  name?: string;
  status?: string;
  kind?: string;
  appBlockId?: string | null;
};

/**
 * A fake `appListing.findMany` that EVALUATES the ownership predicate the way Postgres
 * would, against a small in-memory table.
 *
 * 🔴 It interprets the real `where` rather than returning a canned list. A canned fake
 * makes the query's predicate unobservable — every mutant to the OR branches would still
 * pass, which is fixture collapse: the fake and the implementation would agree on
 * everything because the fake encodes no independent notion of who owns what.
 */
type Row = {
  id: string;
  slug: string;
  name: string;
  status: string;
  kind: string;
  appBlockId: string | null;
  revisionOfId: string | null;
  /** `OauthClient.userId` reached via the block. `null` = the listing has no block. */
  blockOwnerUserId: number | null;
  /** The DENORMALIZED column. Deliberately allowed to disagree with the block. */
  columnUserId: number;
};

type FindManyArgs = {
  where?: { revisionOfId?: null; OR?: Array<Record<string, unknown>>; id?: { in: string[] } };
  take?: number;
  select?: Record<string, boolean>;
};

/**
 * 🔴 The rest-parameter signature MATCHES the hoisted mock's declared type
 * (`(..._a: unknown[]) => Promise<unknown[]>`). A narrower, "nicer" parameter type is NOT
 * assignable to it under `strictFunctionTypes`, and `tsconfig.json` EXCLUDES the
 * `__tests__` directories — so a green `pnpm typecheck` says nothing about this file and
 * the error only appears in an explicit test-typecheck.
 *
 * 🔴 And do NOT write that exclude pattern literally in a block comment: a double-star
 * followed by a slash CLOSES the comment, and everything after it is parsed as code
 * (`error TS2304: Cannot find name '__tests__'`). Measured here, not theorised.
 */
function ownershipFake(table: Row[]) {
  return async (...a: unknown[]): Promise<ListingRow[]> => {
    const args = (a[0] ?? {}) as FindManyArgs;
    const where = args.where ?? {};
    let rows = table;
    if (where.id?.in) rows = rows.filter((r) => where.id!.in.includes(r.id));
    if (where.revisionOfId === null) rows = rows.filter((r) => r.revisionOfId === null);
    if (where.OR) {
      const userId = ((): number | undefined => {
        for (const branch of where.OR) {
          const block = branch.appBlock as { app?: { userId?: number } } | null | undefined;
          if (block?.app?.userId != null) return block.app.userId;
          if (typeof branch.userId === 'number') return branch.userId;
        }
        return undefined;
      })();
      // 🔴 The predicate the branches are SUPPOSED to encode: block-first ownership.
      // Written independently here (not copied from the implementation) so a mutant that
      // drops a branch produces a genuinely different answer.
      const wantsBlockBranch = where.OR.some(
        (b) => (b.appBlock as { app?: { userId?: number } } | null)?.app?.userId != null
      );
      const wantsNoBlockBranch = where.OR.some(
        (b) => (b.appBlock as unknown as { is?: null } | null)?.is === null
      );
      rows = rows.filter((r) => {
        if (r.blockOwnerUserId != null) return wantsBlockBranch && r.blockOwnerUserId === userId;
        return wantsNoBlockBranch && r.columnUserId === userId;
      });
    }
    return rows.slice(0, args.take ?? rows.length).map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      status: r.status,
      kind: r.kind,
      appBlockId: r.appBlockId,
    }));
  };
}

function row(over: Partial<Row> & { id: string }): Row {
  return {
    slug: `slug-${over.id}`,
    name: `Name ${over.id}`,
    status: 'approved',
    kind: 'onsite',
    appBlockId: null,
    revisionOfId: null,
    blockOwnerUserId: null,
    columnUserId: OWNER,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.appListing.findMany.mockImplementation(async () => []);
  mockDb.appCollaborator.findMany.mockImplementation(async () => []);
  mockDb.appListing.findUnique.mockImplementation(async () => null);
  mockDb.appCollaborator.findFirst.mockImplementation(async () => null);
});

describe('resolveAccessibleListingIds', () => {
  it('ON-SITE ownership is resolved through the BLOCK, not the denormalized column', async () => {
    const table = [
      // Owned via the block. The column names someone else — a stale denorm copy, which
      // `resolveListingAccess` documents as a real, reachable state.
      row({
        id: 'apl_block_owned',
        appBlockId: 'ab_1',
        blockOwnerUserId: OWNER,
        columnUserId: 999,
      }),
      // The mirror image: the column names OWNER but the block names a stranger. Reading
      // the column would hand the roster to the wrong person.
      row({ id: 'apl_stale_col', appBlockId: 'ab_2', blockOwnerUserId: 999, columnUserId: OWNER }),
    ];
    mockDb.appListing.findMany.mockImplementation(ownershipFake(table));
    const res = await resolveAccessibleListingIds(OWNER);
    expect(res.ownedIds).toEqual(['apl_block_owned']);
    expect(res.ownedIds).not.toContain('apl_stale_col');
  });

  it('OFF-SITE ownership falls back to the column — there is no block in the chain', async () => {
    const table = [
      row({ id: 'apl_offsite', kind: 'offsite', appBlockId: null, columnUserId: OWNER }),
      row({ id: 'apl_offsite_other', kind: 'offsite', appBlockId: null, columnUserId: 999 }),
    ];
    mockDb.appListing.findMany.mockImplementation(ownershipFake(table));
    const res = await resolveAccessibleListingIds(OWNER);
    expect(res.ownedIds).toEqual(['apl_offsite']);
  });

  it('🔴 an OFF-SITE listing is REPRESENTABLE at all — the whole point of the re-key', async () => {
    // `resolveAccessibleAppBlockIds` filters `kind:'onsite'` + `appBlockId: not null`, so
    // this row could never appear there. Here it must.
    mockDb.appListing.findMany.mockImplementation(
      ownershipFake([row({ id: 'apl_off', kind: 'offsite', columnUserId: OWNER })])
    );
    expect((await resolveAccessibleListingIds(OWNER)).allIds).toContain('apl_off');
  });

  it('an ACCEPTED seat contributes, and lands in editorIds — including off-site', async () => {
    mockDb.appListing.findMany.mockImplementation(ownershipFake([]));
    mockDb.appCollaborator.findMany.mockImplementation(async (...a: unknown[]) =>
      (a[0] as { where: { status: string } }).where.status === 'accepted'
        ? [{ appListingId: 'apl_seat_offsite' }]
        : []
    );
    const res = await resolveAccessibleListingIds(EDITOR);
    expect(res.ownedIds).toEqual([]);
    expect(res.editorIds).toEqual(['apl_seat_offsite']);
    expect(res.allIds).toEqual(['apl_seat_offsite']);
  });

  it('🔴 ONLY `accepted` seats — the status filter is passed to the query', async () => {
    mockDb.appListing.findMany.mockImplementation(ownershipFake([]));
    let seenStatus: unknown;
    mockDb.appCollaborator.findMany.mockImplementation(async (...a: unknown[]) => {
      seenStatus = (a[0] as { where: { status: string; userId: number } }).where.status;
      return [];
    });
    await resolveAccessibleListingIds(EDITOR);
    // A pending/rejected invite must confer nothing; the filter is the consent gate.
    expect(seenStatus).toBe('accepted');
  });

  it('SHADOW revisions are excluded — `revisionOfId: null` reaches the query', async () => {
    const table = [
      row({ id: 'apl_parent', kind: 'offsite', columnUserId: OWNER }),
      row({ id: 'apl_shadow', kind: 'offsite', columnUserId: OWNER, revisionOfId: 'apl_parent' }),
    ];
    mockDb.appListing.findMany.mockImplementation(ownershipFake(table));
    const res = await resolveAccessibleListingIds(OWNER);
    expect(res.ownedIds).toEqual(['apl_parent']);
  });

  it('owned ∩ editor is empty: a hand-written self-seat counts ONCE, as ownership', async () => {
    mockDb.appListing.findMany.mockImplementation(
      ownershipFake([row({ id: 'apl_1', kind: 'offsite', columnUserId: OWNER })])
    );
    mockDb.appCollaborator.findMany.mockImplementation(async () => [
      { appListingId: 'apl_1' },
      { appListingId: 'apl_1' },
    ]);
    const res = await resolveAccessibleListingIds(OWNER);
    expect(res.ownedIds).toEqual(['apl_1']);
    expect(res.editorIds).toEqual([]);
    expect(res.allIds).toEqual(['apl_1']);
  });

  it('a stranger gets an empty set (and the read is not skipped)', async () => {
    mockDb.appListing.findMany.mockImplementation(
      ownershipFake([row({ id: 'apl_1', kind: 'offsite', columnUserId: OWNER })])
    );
    const res = await resolveAccessibleListingIds(STRANGER);
    expect(res).toEqual({ ownedIds: [], editorIds: [], allIds: [] });
    expect(mockDb.appListing.findMany).toHaveBeenCalled();
  });

  it('degrades to owner-only when the collaborator table is ABSENT (42P01)', async () => {
    mockDb.appListing.findMany.mockImplementation(
      ownershipFake([row({ id: 'apl_1', kind: 'offsite', columnUserId: OWNER })])
    );
    mockDb.appCollaborator.findMany.mockImplementation(async () => {
      throw Object.assign(new Error('relation "app_collaborators" does not exist'), {
        code: '42P01',
      });
    });
    const res = await resolveAccessibleListingIds(OWNER);
    expect(res.ownedIds).toEqual(['apl_1']);
    expect(res.editorIds).toEqual([]);
  });

  it('does NOT swallow a COLUMN error (42703 — a half-applied migration must surface)', async () => {
    mockDb.appListing.findMany.mockImplementation(ownershipFake([]));
    mockDb.appCollaborator.findMany.mockImplementation(async () => {
      throw Object.assign(new Error('column "displayed" does not exist'), { code: '42703' });
    });
    await expect(resolveAccessibleListingIds(OWNER)).rejects.toThrow(/column "displayed"/);
  });
});

describe('listMyAppListings', () => {
  const table = [
    row({ id: 'apl_on', kind: 'onsite', appBlockId: 'ab_1', blockOwnerUserId: OWNER }),
    row({ id: 'apl_off', kind: 'offsite', appBlockId: null, columnUserId: OWNER }),
  ];

  it('rows carry role + KIND-DERIVED capabilities, per kind', async () => {
    mockDb.appListing.findMany.mockImplementation(ownershipFake(table));
    const rows = await listMyAppListings({ userId: OWNER });
    const onsite = rows.find((r) => r.appListingId === 'apl_on');
    const offsite = rows.find((r) => r.appListingId === 'apl_off');
    expect(onsite?.role).toBe('owner');
    expect(onsite?.capabilities.earnings).toBe(true);
    expect(onsite?.capabilities.submitVersion).toBe(true);
    // 🔴 The two structural `false` cells — an off-site listing has no AppBlock, so no
    // attribution row can exist and there is no repo to push to.
    expect(offsite?.capabilities.earnings).toBe(false);
    expect(offsite?.capabilities.submitVersion).toBe(false);
    // …and the capabilities BOTH kinds share are not accidentally narrowed.
    expect(offsite?.capabilities.listingContent).toBe(true);
    expect(offsite?.capabilities.analytics).toBe(true);
  });

  it('a seated listing comes back with role `editor`, not `owner`', async () => {
    mockDb.appListing.findMany.mockImplementation(
      ownershipFake([row({ id: 'apl_seat', kind: 'offsite', columnUserId: 999 })])
    );
    mockDb.appCollaborator.findMany.mockImplementation(async () => [{ appListingId: 'apl_seat' }]);
    const rows = await listMyAppListings({ userId: EDITOR });
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('editor');
    expect(rows[0].appListingId).toBe('apl_seat');
  });

  it('returns [] without a second query when nothing is accessible', async () => {
    mockDb.appListing.findMany.mockImplementation(ownershipFake([]));
    expect(await listMyAppListings({ userId: STRANGER })).toEqual([]);
    // One call for the ownership probe; the hydrate must NOT run on an empty set.
    expect(mockDb.appListing.findMany).toHaveBeenCalledTimes(1);
  });

  it('clamps the limit into (0, MY_APP_LISTINGS_LIMIT]', async () => {
    const takes: unknown[] = [];
    mockDb.appListing.findMany.mockImplementation(async (...a: unknown[]) => {
      const take = (a[0] as { take?: number }).take;
      if (take !== undefined) takes.push(take);
      return [row({ id: 'apl_off', kind: 'offsite', columnUserId: OWNER })];
    });
    await listMyAppListings({ userId: OWNER, limit: 10_000 });
    await listMyAppListings({ userId: OWNER, limit: 0 });
    await listMyAppListings({ userId: OWNER });
    expect(takes).toEqual([MY_APP_LISTINGS_LIMIT, 1, MY_APP_LISTINGS_LIMIT]);
  });
});

describe('getAppListingAuthoringContext', () => {
  function listingFixture(over: Record<string, unknown> = {}) {
    return {
      id: 'apl_1',
      userId: OWNER,
      kind: 'onsite',
      appBlockId: 'ab_1',
      revisionOfId: null,
      appBlock: { app: { userId: OWNER } },
      revisionOf: null,
      ...over,
    };
  }

  it('the OWNER gets role owner + the kind-derived capabilities', async () => {
    mockDb.appListing.findUnique.mockImplementation(async (...a: unknown[]) =>
      (a[0] as { select?: { slug?: boolean } }).select?.slug
        ? { id: 'apl_1', slug: 'my-app', name: 'My App', status: 'approved' }
        : listingFixture()
    );
    const ctx = await getAppListingAuthoringContext({ appListingId: 'apl_1', userId: OWNER });
    expect(ctx.role).toBe('owner');
    expect(ctx.kind).toBe('onsite');
    expect(ctx.appBlockId).toBe('ab_1');
    expect(ctx.slug).toBe('my-app');
    expect(ctx.capabilities.earnings).toBe(true);
  });

  it('an ACCEPTED seat gets role editor', async () => {
    mockDb.appListing.findUnique.mockImplementation(async (...a: unknown[]) =>
      (a[0] as { select?: { slug?: boolean } }).select?.slug
        ? { id: 'apl_1', slug: 'my-app', name: 'My App', status: 'approved' }
        : listingFixture()
    );
    mockDb.appCollaborator.findFirst.mockImplementation(async () => ({ userId: EDITOR }));
    const ctx = await getAppListingAuthoringContext({ appListingId: 'apl_1', userId: EDITOR });
    expect(ctx.role).toBe('editor');
  });

  it('🔴 a stranger is REFUSED (FORBIDDEN), not handed a role-less row', async () => {
    mockDb.appListing.findUnique.mockImplementation(async (...a: unknown[]) =>
      (a[0] as { select?: { slug?: boolean } }).select?.slug
        ? { id: 'apl_1', slug: 'my-app', name: 'My App', status: 'approved' }
        : listingFixture()
    );
    mockDb.appCollaborator.findFirst.mockImplementation(async () => null);
    await expect(
      getAppListingAuthoringContext({ appListingId: 'apl_1', userId: STRANGER })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a PENDING invitee is a stranger here — an unaccepted invite confers nothing', async () => {
    mockDb.appListing.findUnique.mockImplementation(async (...a: unknown[]) =>
      (a[0] as { select?: { slug?: boolean } }).select?.slug
        ? { id: 'apl_1', slug: 'my-app', name: 'My App', status: 'approved' }
        : listingFixture()
    );
    // `hasAcceptedSeat` filters `status: accepted`, so a pending row is simply not found.
    mockDb.appCollaborator.findFirst.mockImplementation(async (...a: unknown[]) =>
      (a[0] as { where: { status: string } }).where.status === 'accepted'
        ? null
        : { userId: EDITOR }
    );
    await expect(
      getAppListingAuthoringContext({ appListingId: 'apl_1', userId: EDITOR })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a missing listing is NOT_FOUND', async () => {
    mockDb.appListing.findUnique.mockImplementation(async () => null);
    await expect(
      getAppListingAuthoringContext({ appListingId: 'nope', userId: OWNER })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('🔴 a SHADOW resolves to its PARENT: parent id, parent kind, parent block', async () => {
    // A shadow carries `appBlockId: null` by construction. Reading kind/block off the
    // shadow would make an in-flight revision look off-site and silently strip the
    // block-only tabs from the editor.
    mockDb.appListing.findUnique.mockImplementation(async (...a: unknown[]) =>
      (a[0] as { select?: { slug?: boolean } }).select?.slug
        ? { id: 'apl_parent', slug: 'my-app', name: 'My App', status: 'approved' }
        : listingFixture({
            id: 'apl_shadow',
            appBlockId: null,
            revisionOfId: 'apl_parent',
            appBlock: null,
            revisionOf: {
              id: 'apl_parent',
              kind: 'onsite',
              appBlockId: 'ab_1',
              appBlock: { app: { userId: OWNER } },
            },
          })
    );
    const ctx = await getAppListingAuthoringContext({ appListingId: 'apl_shadow', userId: OWNER });
    expect(ctx.appListingId).toBe('apl_parent');
    expect(ctx.kind).toBe('onsite');
    expect(ctx.appBlockId).toBe('ab_1');
    expect(ctx.capabilities.submitVersion).toBe(true);
  });
});

describe('listingIdForAppBlock', () => {
  it('maps a block to its listing id', async () => {
    mockDb.appListing.findUnique.mockImplementation(async () => ({ id: 'apl_1' }));
    expect(await listingIdForAppBlock('ab_1')).toBe('apl_1');
  });

  it('returns null for a block with no listing yet (a first-version app)', async () => {
    mockDb.appListing.findUnique.mockImplementation(async () => null);
    expect(await listingIdForAppBlock('ab_new')).toBeNull();
  });
});
