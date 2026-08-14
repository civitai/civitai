import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 🔴 ISSUE #3844 — `resolveListingAccess` was BLOCK-FIRST, not KIND-AWARE.
 *
 * ## The defect, exactly
 *
 * Ownership was resolved as `appBlock.app.userId ?? listing.userId`, with no branch on
 * `kind`. That READS as kind-aware only because an ordinary off-site listing has no
 * `AppBlock`, so the `?? ` fallback was the only branch anyone ever reached.
 *
 * `mapAppBlockToListing` mints `kind:'offsite'` WITH a non-null `appBlockId` for any
 * `AppBlock` carrying an `externalUrl` (reachable from `publish-request.service`'s approve
 * path and the mod proc `backfillAppListings`). On THAT shape the block decided ownership
 * — while both off-site ownership writers move only the column:
 *
 *   - `app-ownership-transfer.service::acceptTransfer` — its step (2) `OauthClient` move
 *     is `if (isOnsite)`-guarded, so the off-site path writes `AppListing.userId` alone;
 *   - `offsite-moderation.service::claimListing` — the mod IMPERSONATION REMEDY
 *     (report → delist → claim → ban), which refuses a non-offsite listing outright.
 *
 * So after either write the resolver kept naming the OLD owner. The previous owner — or
 * the impersonator a moderator had just dispossessed — retained edit access, and the
 * rightful owner was refused. A two-sided authorization inversion.
 *
 * ## 🔴 A SECOND, INDEPENDENT ARM OF THE SAME DEFECT: the SHADOW's frozen column
 *
 * `beginListingRevision` clones an approved parent into a hidden draft with
 * `userId: parent.userId` and `appBlockId: null`, and NOTHING ever revisits that clone
 * (`claimListing` and `acceptTransfer` both write `where: { id: <the parent> }`). For an
 * ON-SITE listing the block covers it — that is what
 * `app-access.denormalized-owner-drift.test.ts` pins. For an OFF-SITE listing the column
 * IS the owner, so reading the SHADOW's copy reproduces the identical inversion **with no
 * block involved at all**. This suite fixes it by resolving the column from the PARENT,
 * the same row the resolver already takes `kind` and `appBlockId` from.
 *
 * ## Blast radius, stated honestly
 *
 * The block arm was measured against production on 2026-08-12 and is not merely 0-row, it
 * is UNMINTABLE: `kind='offsite' AND app_block_id IS NOT NULL` → 0 rows, 0 of 22
 * `app_blocks` carry an `external_url`, and no writer of that column exists in
 * `src/server`. So that arm is a LATENT inversion closed before anything can mint it — not
 * a live exploit, and not cosmetic either.
 *
 * The shadow arm is NOT covered by that measurement: it needs no block. It was derived
 * from the code (the clone, and the two `where: { id }` writes), not measured against
 * production — this suite does not claim a row count for it.
 *
 * ## What this file asserts
 *
 * The DEFINING surface — `resolveListingAccess`, its pure helper
 * `resolveCanonicalListingOwner`, and the query-predicate form
 * `canonicalOwnerWhereBranches` that the two SET reads share. The five consolidated GATES
 * are driven end-to-end in `app-access.denormalized-owner-drift.test.ts`; the two
 * WRITE-side loaders in `app-collaborator.service.test.ts` and
 * `app-ownership-transfer.service.test.ts`.
 */

const { read, write, store, branchMatches, ids } = vi.hoisted(() => {
  type ListingRow = {
    id: string;
    kind: string;
    status: string;
    slug: string;
    name: string;
    userId: number;
    appBlockId: string | null;
    revisionOfId: string | null;
    externalUrl: string | null;
    connectClientId: string | null;
  };
  const store = {
    listings: new Map<string, ListingRow>(),
    /** `AppBlock.id` → the `OauthClient.userId` behind it (`null` = dangling `app_id`). */
    blockOwners: new Map<string, number | null>(),
    seats: [] as Array<{ appListingId: string; userId: number; status: string }>,
  };

  /**
   * 🔴 THE FAKE RETURNS WHOLE ROWS AND IGNORES `select`, DELIBERATELY.
   *
   * Every assertion here is about WHICH FIELD the implementation reads, so a fake that
   * pre-narrowed the row to the fields the CURRENT implementation happens to select would
   * make the pre-fix code die on a `TypeError` instead of returning a wrong answer — a
   * failure that proves nothing about the gate. Handing back everything means the pre-fix
   * and the post-fix code see the SAME row and differ only in what they do with it.
   *
   * The one thing that is NOT ignored is the `where` clause: see `branchMatches`.
   */
  const projectListing = (id: string | null | undefined, depth = 0): unknown => {
    if (!id) return null;
    const row = store.listings.get(id);
    if (!row) return null;
    const blockOwner = row.appBlockId ? store.blockOwners.get(row.appBlockId) : undefined;
    return {
      ...row,
      appBlock: row.appBlockId
        ? {
            id: row.appBlockId,
            blockId: `blk-${row.appBlockId}`,
            appId: `oc_${row.appBlockId}`,
            app: blockOwner == null ? null : { userId: blockOwner },
          }
        : null,
      // One level only — a shadow's parent is never itself a shadow
      // (`beginListingRevision` refuses a revision of a revision).
      revisionOf: depth === 0 ? projectListing(row.revisionOfId, 1) : null,
    };
  };

  /**
   * 🔴 AN INDEPENDENT EVALUATOR OF THE OWNERSHIP `OR`, WRITTEN FROM THE SPEC.
   *
   * It recognises each branch by BOTH halves of what it says — its `kind` clause AND its
   * ownership clause — and THROWS on a branch shape it does not recognise. That last part
   * is what makes it a guard rather than a rubber stamp: a predicate silently rewritten
   * into a shape this evaluator was never taught would otherwise answer "no rows", the
   * reassuring zero this repo keeps paying for. Here it is a loud error instead.
   */
  const branchMatches = (
    branch: Record<string, unknown>,
    row: Record<string, unknown>
  ): boolean => {
    const kind = branch.kind;
    const block = branch.appBlock as { app?: { userId?: number }; is?: null } | undefined;
    const rowKind = row.kind as string;
    const rowBlockOwner = row.appBlockId
      ? store.blockOwners.get(row.appBlockId as string) ?? null
      : null;
    // (1) onsite + the block's OauthClient owner.
    if (kind === 'onsite' && block?.app?.userId != null) {
      return rowKind === 'onsite' && rowBlockOwner === block.app.userId;
    }
    // (2) onsite + NO block ⇒ the column is the only owner signal left.
    if (kind === 'onsite' && block?.is === null && typeof branch.userId === 'number') {
      return rowKind === 'onsite' && row.appBlockId == null && row.userId === branch.userId;
    }
    // (3) NOT onsite ⇒ the column, whether or not a block hangs off the row. The #3844 arm.
    if (
      (kind as { not?: string } | undefined)?.not === 'onsite' &&
      typeof branch.userId === 'number'
    ) {
      return rowKind !== 'onsite' && row.userId === branch.userId;
    }
    throw new Error(
      `unrecognised ownership OR branch — the predicate changed shape: ${JSON.stringify(branch)}`
    );
  };

  const matchesWhere = (where: Record<string, unknown>, row: Record<string, unknown>): boolean => {
    if (where.revisionOfId === null && row.revisionOfId !== null) return false;
    const or = where.OR as Array<Record<string, unknown>> | undefined;
    if (or) return or.some((b) => branchMatches(b, row));
    return true;
  };

  const makeClient = () => ({
    appListing: {
      findUnique: vi.fn(async (...a: unknown[]) => {
        const args = (a[0] ?? {}) as { where?: { id?: string; appBlockId?: string } };
        if (args.where?.appBlockId) {
          for (const row of store.listings.values()) {
            if (row.appBlockId === args.where.appBlockId) return projectListing(row.id);
          }
          return null;
        }
        return projectListing(args.where?.id);
      }),
      findFirst: vi.fn(async (...a: unknown[]) => {
        const args = (a[0] ?? {}) as { where?: Record<string, unknown> };
        for (const row of store.listings.values()) {
          if (matchesWhere(args.where ?? {}, row as unknown as Record<string, unknown>)) {
            return projectListing(row.id);
          }
        }
        return null;
      }),
      findMany: vi.fn(async (...a: unknown[]) => {
        const args = (a[0] ?? {}) as { where?: Record<string, unknown> };
        const out: unknown[] = [];
        for (const row of store.listings.values()) {
          if (matchesWhere(args.where ?? {}, row as unknown as Record<string, unknown>)) {
            out.push(projectListing(row.id));
          }
        }
        return out;
      }),
      updateMany: vi.fn(async (...a: unknown[]) => {
        const args = (a[0] ?? {}) as {
          where: { id: string; kind?: string; status?: { in?: string[] }; userId?: number };
          data: { userId?: number };
        };
        const row = store.listings.get(args.where.id);
        if (!row) return { count: 0 };
        if (args.where.kind != null && row.kind !== args.where.kind) return { count: 0 };
        if (args.where.status?.in && !args.where.status.in.includes(row.status)) {
          return { count: 0 };
        }
        if (args.where.userId != null && row.userId !== args.where.userId) return { count: 0 };
        if (typeof args.data.userId === 'number') row.userId = args.data.userId;
        return { count: 1 };
      }),
    },
    appBlock: {
      findUnique: vi.fn(async (...a: unknown[]) => {
        const args = (a[0] ?? {}) as { where?: { id?: string } };
        const id = args.where?.id;
        if (!id || !store.blockOwners.has(id)) return null;
        const owner = store.blockOwners.get(id) ?? null;
        let appListing: { id: string } | null = null;
        for (const row of store.listings.values()) {
          if (row.appBlockId === id) appListing = { id: row.id };
        }
        return { id, app: owner == null ? null : { userId: owner }, appListing };
      }),
      findMany: vi.fn(async (...a: unknown[]) => {
        const args = (a[0] ?? {}) as { where?: { app?: { userId?: number } } };
        const want = args.where?.app?.userId;
        return [...store.blockOwners.entries()]
          .filter(([, owner]) => owner != null && owner === want)
          .map(([id]) => ({ id }));
      }),
    },
    appCollaborator: {
      findFirst: vi.fn(async (...a: unknown[]) => {
        const w = (a[0] as { where: { appListingId?: string; userId: number; status?: string } })
          .where;
        return (
          store.seats.find(
            (s) =>
              (w.appListingId == null || s.appListingId === w.appListingId) &&
              s.userId === w.userId &&
              (w.status == null || s.status === w.status)
          ) ?? null
        );
      }),
      findMany: vi.fn(async (...a: unknown[]) => {
        const w = (a[0] as { where: { userId?: number; status?: string } }).where;
        return store.seats.filter(
          (s) =>
            (w.userId == null || s.userId === w.userId) &&
            (w.status == null || s.status === w.status)
        );
      }),
      count: vi.fn(async () => store.seats.length),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    appListingModerationEvent: { create: vi.fn(async (a: { data: unknown }) => a.data) },
    appListingReport: { updateMany: vi.fn(async () => ({ count: 0 })) },
    appOwnershipTransfer: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      // `resolveAppsNavAccess` also probes for an inbound ownership OFFER (it lights the
      // same "Invites" tab as a seat invite). No transfers exist in this suite's fixtures
      // — the offer arm is covered by `app-access.nav-pending-invites.test.ts`.
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    },
    appOwnershipEvent: { create: vi.fn(async (a: { data: unknown }) => a.data) },
    user: { findUnique: vi.fn(async (a: { where: { id: number } }) => ({ id: a.where.id })) },
    $transaction: vi.fn(async (arg: unknown): Promise<unknown> => arg),
  });

  return { read: makeClient(), write: makeClient(), store, branchMatches, ids: { n: 0 } };
});

vi.mock('~/server/db/client', () => ({ dbRead: read, dbWrite: write }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn(async () => undefined) }));
vi.mock('~/server/services/blocks/app-listing-notify', () => ({
  notifyAppListingOwner: vi.fn(async () => undefined),
}));
vi.mock('~/server/utils/app-block-ids', () => ({
  newAppListingReportId: () => `alrp_${++ids.n}`,
  newAppListingModerationEventId: () => `alme_${++ids.n}`,
  newAppListingPublishRequestId: () => `alpr_${++ids.n}`,
  newAppOwnershipEventId: () => `aoe_${++ids.n}`,
  newAppListingId: () => `apl_${++ids.n}`,
  newAppListingScreenshotId: () => `apls_${++ids.n}`,
  newUlid: () => `ULID${++ids.n}`,
}));

const {
  resolveCanonicalListingOwner,
  canonicalOwnerWhereBranches,
  resolveListingAccess,
  resolveAccessibleListingIds,
  resolveAppsNavAccess,
} = await import('~/server/services/blocks/app-access.service');
const { claimListing } = await import('~/server/services/blocks/offsite-moderation.service');

// 🔴 PAIRWISE-DISTINCT. Two roles sharing a number is how a fixture "proves" a gate that
// is actually reading the wrong field.
/** Who `AppListing.userId` names — the RIGHTFUL owner of an off-site listing. */
const RIGHTFUL = 41;
/** Who the attached `AppBlock`'s OauthClient names — the EX-owner / impersonator. */
const EX_OWNER = 62;
/** Holds an ACCEPTED seat. */
const EDITOR = 73;
/** No relationship to anything. */
const STRANGER = 84;
/** The moderator running the impersonation remedy. */
const REVIEWER = 95;

const PARENT = 'apl_parent';
const SHADOW = 'apl_shadow';
const BLOCK = 'ab_backing';

type RowOver = Partial<{
  id: string;
  kind: string;
  status: string;
  slug: string;
  name: string;
  userId: number;
  appBlockId: string | null;
  revisionOfId: string | null;
  externalUrl: string | null;
  connectClientId: string | null;
}>;

function putListing(over: RowOver & { id: string }) {
  store.listings.set(over.id, {
    kind: 'offsite',
    status: 'approved',
    slug: `slug-${over.id}`,
    name: `Name ${over.id}`,
    userId: RIGHTFUL,
    appBlockId: null,
    revisionOfId: null,
    externalUrl: 'https://example.com/',
    connectClientId: null,
    ...over,
  });
}

/** 🔴 THE HAZARDOUS SHAPE: `kind:'offsite'` carrying a block whose owner DISAGREES. */
function offsiteWithBlock(over: RowOver = {}) {
  store.blockOwners.set(BLOCK, EX_OWNER);
  putListing({ id: PARENT, kind: 'offsite', appBlockId: BLOCK, userId: RIGHTFUL, ...over });
}

beforeEach(() => {
  vi.clearAllMocks();
  ids.n = 0;
  store.listings.clear();
  store.blockOwners.clear();
  store.seats.length = 0;
  // The interactive transaction runs its callback against the WRITE mock itself, so an
  // in-tx write lands on the same in-memory store the resolver then reads.
  write.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: unknown) => Promise<unknown>)(write)
      : Promise.all(arg as Promise<unknown>[])
  );
  read.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: unknown) => Promise<unknown>)(read)
      : Promise.all(arg as Promise<unknown>[])
  );
});

// ---------------------------------------------------------------------------

describe('🔴 POSITIVE CONTROLS: the fixture and the fake are both real', () => {
  it('the hazardous shape really is offsite, really carries a block, and the two owners DIFFER', () => {
    offsiteWithBlock();
    const row = store.listings.get(PARENT)!;
    expect(row.kind).toBe('offsite');
    expect(row.appBlockId).toBe(BLOCK);
    expect(row.userId).toBe(RIGHTFUL);
    expect(store.blockOwners.get(BLOCK)).toBe(EX_OWNER);
    expect(RIGHTFUL).not.toBe(EX_OWNER);
  });

  it('the fake HONOURS a where-clause: it can match AND it can miss', async () => {
    // 🔴 A prior round of this feature shipped a user fake that ignored its where-clause,
    // which would have made every filter assertion below vacuously true. Both directions
    // are exercised: the same call shape returns the row for one id and null for another.
    offsiteWithBlock();
    expect(await read.appListing.findUnique({ where: { id: PARENT } })).toMatchObject({
      id: PARENT,
    });
    expect(await read.appListing.findUnique({ where: { id: 'apl_nope' } })).toBeNull();
    // …and the relation hop is resolved from the store, not canned.
    expect(await read.appListing.findUnique({ where: { appBlockId: BLOCK } })).toMatchObject({
      id: PARENT,
    });
    expect(await read.appListing.findUnique({ where: { appBlockId: 'ab_nope' } })).toBeNull();
  });

  it('the ownership-OR evaluator can return TRUE and FALSE, and THROWS on an unknown branch', () => {
    offsiteWithBlock();
    const row = store.listings.get(PARENT)! as unknown as Record<string, unknown>;
    const branches = canonicalOwnerWhereBranches(RIGHTFUL);
    expect(branches.some((b) => branchMatches(b, row))).toBe(true);
    expect(canonicalOwnerWhereBranches(STRANGER).some((b) => branchMatches(b, row))).toBe(false);
    // The guard that keeps a silently-rewritten predicate from reading as "no rows".
    expect(() => branchMatches({ somethingElse: true }, row)).toThrow(/unrecognised ownership OR/);
  });
});

// ---------------------------------------------------------------------------

describe('resolveCanonicalListingOwner — the pure kind branch', () => {
  it('onsite: the BLOCK wins over the column', () => {
    expect(
      resolveCanonicalListingOwner({
        kind: 'onsite',
        blockOwnerUserId: EX_OWNER,
        listingUserId: RIGHTFUL,
      })
    ).toBe(EX_OWNER);
  });

  it('onsite with a DANGLING app_id: falls back to the column', () => {
    // An app nobody owns would lock the listing's real owner out entirely.
    expect(
      resolveCanonicalListingOwner({
        kind: 'onsite',
        blockOwnerUserId: null,
        listingUserId: RIGHTFUL,
      })
    ).toBe(RIGHTFUL);
    expect(
      resolveCanonicalListingOwner({
        kind: 'onsite',
        blockOwnerUserId: undefined,
        listingUserId: RIGHTFUL,
      })
    ).toBe(RIGHTFUL);
  });

  it('🔴 offsite: the COLUMN wins even when a block is attached (#3844)', () => {
    expect(
      resolveCanonicalListingOwner({
        kind: 'offsite',
        blockOwnerUserId: EX_OWNER,
        listingUserId: RIGHTFUL,
      })
    ).toBe(RIGHTFUL);
  });

  it('an UNKNOWN kind falls through to the column — fail-closed, matching capabilitiesForKind', () => {
    // `capabilitiesForKind` falls back to the narrower (offsite) row for an unknown kind;
    // the owner resolution matches it rather than handing an unrecognised kind the block.
    expect(
      resolveCanonicalListingOwner({
        kind: 'something-new',
        blockOwnerUserId: EX_OWNER,
        listingUserId: RIGHTFUL,
      })
    ).toBe(RIGHTFUL);
  });
});

// ---------------------------------------------------------------------------

describe('🔴 resolveListingAccess on an OFF-SITE listing that carries a block (#3844)', () => {
  it('GRANTS the rightful (column) owner', async () => {
    offsiteWithBlock();
    const access = await resolveListingAccess(PARENT, RIGHTFUL);
    expect(access?.ownerUserId).toBe(RIGHTFUL);
    expect(access?.role).toBe('owner');
  });

  it('REFUSES the ex-owner the attached block still names', async () => {
    // The security-relevant half. A fix that only granted would be half a fix.
    offsiteWithBlock();
    const access = await resolveListingAccess(PARENT, EX_OWNER);
    expect(access?.ownerUserId).toBe(RIGHTFUL);
    expect(access?.role).toBeNull();
  });

  it('the block does NOT decide even when the column names nobody special', async () => {
    offsiteWithBlock({ userId: STRANGER });
    expect((await resolveListingAccess(PARENT, EX_OWNER))?.role).toBeNull();
    expect((await resolveListingAccess(PARENT, STRANGER))?.role).toBe('owner');
  });

  it('an ACCEPTED seat still confers `editor`, and a stranger still gets null', async () => {
    // The fix must move the OWNER half without touching the seat half in either direction.
    offsiteWithBlock();
    store.seats.push({ appListingId: PARENT, userId: EDITOR, status: 'accepted' });
    expect((await resolveListingAccess(PARENT, EDITOR))?.role).toBe('editor');
    expect((await resolveListingAccess(PARENT, STRANGER))?.role).toBeNull();
  });

  it('a PENDING seat confers nothing — the consent gate is untouched', async () => {
    offsiteWithBlock();
    store.seats.push({ appListingId: PARENT, userId: EDITOR, status: 'pending' });
    expect((await resolveListingAccess(PARENT, EDITOR))?.role).toBeNull();
  });
});

describe('🔴 CONTROL: ON-SITE precedence is NOT regressed', () => {
  it('a STALE denormalized column loses to the block, in both directions', async () => {
    // The case a naive "just use listing.userId" fix would break. `AppListing.userId` is a
    // denormalized copy for onsite; `OauthClient.userId` is canonical.
    store.blockOwners.set(BLOCK, RIGHTFUL);
    putListing({ id: PARENT, kind: 'onsite', appBlockId: BLOCK, userId: EX_OWNER });
    const asReal = await resolveListingAccess(PARENT, RIGHTFUL);
    expect(asReal?.ownerUserId).toBe(RIGHTFUL);
    expect(asReal?.role).toBe('owner');
    const asStale = await resolveListingAccess(PARENT, EX_OWNER);
    expect(asStale?.ownerUserId).toBe(RIGHTFUL);
    expect(asStale?.role).toBeNull();
  });

  it('an onsite block with a DANGLING app_id still falls back to the column', async () => {
    store.blockOwners.set(BLOCK, null);
    putListing({ id: PARENT, kind: 'onsite', appBlockId: BLOCK, userId: RIGHTFUL });
    const access = await resolveListingAccess(PARENT, RIGHTFUL);
    expect(access?.ownerUserId).toBe(RIGHTFUL);
    expect(access?.role).toBe('owner');
  });

  it('an onsite listing with NO block at all resolves from the column', async () => {
    // Pre-approval onsite drafts exist with `appBlockId: null`.
    putListing({ id: PARENT, kind: 'onsite', status: 'draft', appBlockId: null, userId: RIGHTFUL });
    expect((await resolveListingAccess(PARENT, RIGHTFUL))?.role).toBe('owner');
    expect((await resolveListingAccess(PARENT, STRANGER))?.role).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('🔴 the SHADOW arm: an off-site shadow must not freeze the old owner', () => {
  /**
   * The parent's ownership moved (a claim or an off-site transfer wrote its column); the
   * shadow, cloned earlier, still carries the OLD value. No block is involved — this arm
   * needs none, which is why it is the one that does not depend on the unmintable shape.
   */
  function offsiteParentWithStaleShadow() {
    putListing({ id: PARENT, kind: 'offsite', userId: RIGHTFUL, appBlockId: null });
    putListing({
      id: SHADOW,
      kind: 'offsite',
      status: 'draft',
      userId: EX_OWNER, // frozen at clone time
      appBlockId: null,
      revisionOfId: PARENT,
    });
  }

  it('POSITIVE CONTROL: the shadow really does disagree with its parent', () => {
    offsiteParentWithStaleShadow();
    expect(store.listings.get(SHADOW)!.userId).toBe(EX_OWNER);
    expect(store.listings.get(PARENT)!.userId).toBe(RIGHTFUL);
  });

  it('GRANTS the parent’s current owner on the shadow', async () => {
    offsiteParentWithStaleShadow();
    const access = await resolveListingAccess(SHADOW, RIGHTFUL);
    expect(access?.seatListingId).toBe(PARENT);
    expect(access?.ownerUserId).toBe(RIGHTFUL);
    expect(access?.role).toBe('owner');
  });

  it('REFUSES the ex-owner the shadow’s frozen column still names', async () => {
    offsiteParentWithStaleShadow();
    const access = await resolveListingAccess(SHADOW, EX_OWNER);
    expect(access?.ownerUserId).toBe(RIGHTFUL);
    expect(access?.role).toBeNull();
  });

  it('an editor seated on the PARENT still reaches the shadow', async () => {
    offsiteParentWithStaleShadow();
    store.seats.push({ appListingId: PARENT, userId: EDITOR, status: 'accepted' });
    expect((await resolveListingAccess(SHADOW, EDITOR))?.role).toBe('editor');
  });

  it('🔴 STRUCTURAL: the query SELECTS the parent’s owner column', async () => {
    // A behavioural assertion alone cannot tell "read from the parent" from "the fake
    // happened to return the same number". This pins that the field is asked for.
    offsiteParentWithStaleShadow();
    await resolveListingAccess(SHADOW, RIGHTFUL);
    const args = read.appListing.findUnique.mock.calls[0][0] as {
      select: { revisionOf?: { select: { userId?: boolean } } };
    };
    expect(args.select.revisionOf?.select.userId).toBe(true);
  });

  it('a narrow fixture with no `revisionOf` relation still resolves (no crash, column fallback)', async () => {
    // `revisionOfId` is the authoritative "am I a shadow" signal; the relation may be
    // absent from a narrow select. That path must degrade, not throw.
    read.appListing.findUnique.mockResolvedValueOnce({
      id: SHADOW,
      userId: RIGHTFUL,
      kind: 'offsite',
      appBlockId: null,
      revisionOfId: PARENT,
      appBlock: null,
      revisionOf: null,
    });
    const access = await resolveListingAccess(SHADOW, RIGHTFUL);
    expect(access?.seatListingId).toBe(PARENT);
    expect(access?.ownerUserId).toBe(RIGHTFUL);
  });
});

// ---------------------------------------------------------------------------

describe('🔴 THE IMPERSONATION REMEDY: claimListing must actually dispossess', () => {
  /**
   * The concrete harm the issue names. `claimListing` is the mod remedy for impersonation
   * (report → delist → claim → ban): a moderator verifies ownership out-of-band and
   * re-points `AppListing.userId` at the real owner. It writes ONLY that column and
   * refuses a non-offsite listing outright.
   *
   * 🔴 THIS IS A SEAM TEST, NOT TWO UNIT TESTS. The write and the read run against the
   * SAME in-memory store, so nothing here can pass by a fixture that merely ASSERTS the
   * post-claim state — the state is whatever `claimListing` actually wrote. Two components
   * each individually correct can still be broken together; that is what this asserts.
   */
  const REASON = 'impersonates a real vendor';

  it('POSITIVE CONTROL: before the claim, the impersonator IS the resolved owner', async () => {
    // Without this, "the impersonator is refused afterwards" is indistinguishable from a
    // fixture in which they never had access at all.
    offsiteWithBlock({ userId: EX_OWNER });
    expect((await resolveListingAccess(PARENT, EX_OWNER))?.role).toBe('owner');
    expect((await resolveListingAccess(PARENT, RIGHTFUL))?.role).toBeNull();
  });

  it('🔴 after the claim, the impersonator LOSES edit access and the rightful owner GAINS it', async () => {
    offsiteWithBlock({ userId: EX_OWNER });
    const res = await claimListing({
      input: { appListingId: PARENT, targetUserId: RIGHTFUL, reason: REASON },
      reviewerUserId: REVIEWER,
    });
    expect(res).toEqual({ appListingId: PARENT, userId: RIGHTFUL });
    // The claim moved the column — and NOT the block, which still names the impersonator.
    expect(store.listings.get(PARENT)!.userId).toBe(RIGHTFUL);
    expect(store.blockOwners.get(BLOCK)).toBe(EX_OWNER);
    // …and the resolver agrees with the remedy rather than with the residue.
    expect((await resolveListingAccess(PARENT, EX_OWNER))?.role).toBeNull();
    const granted = await resolveListingAccess(PARENT, RIGHTFUL);
    expect(granted?.ownerUserId).toBe(RIGHTFUL);
    expect(granted?.role).toBe('owner');
  });

  it('the same remedy works on a listing with NO block (the ordinary off-site case)', async () => {
    // The control that keeps the case above attributable to the KIND branch: the ordinary
    // shape was always correct, and must stay correct.
    putListing({ id: PARENT, kind: 'offsite', userId: EX_OWNER, appBlockId: null });
    await claimListing({
      input: { appListingId: PARENT, targetUserId: RIGHTFUL, reason: REASON },
      reviewerUserId: REVIEWER,
    });
    expect((await resolveListingAccess(PARENT, EX_OWNER))?.role).toBeNull();
    expect((await resolveListingAccess(PARENT, RIGHTFUL))?.role).toBe('owner');
  });
});

// ---------------------------------------------------------------------------

describe('🔴 the SET reads agree with the per-listing resolver', () => {
  /**
   * `resolveAccessibleListingIds` (the "my apps" set) and `resolveAppsNavAccess` (the
   * sub-nav probe) express the same ownership rule as a Prisma predicate. A set that
   * disagreed with the resolver would hand a user an entry point that then 403s — or hide
   * a listing they do own. Before #3844 both were block-first, so they agreed on being
   * WRONG on this shape; they must now agree on being right.
   */
  it('the offsite-with-a-block listing appears for the COLUMN owner, not the block owner', async () => {
    offsiteWithBlock();
    expect((await resolveAccessibleListingIds(RIGHTFUL)).ownedIds).toEqual([PARENT]);
    expect((await resolveAccessibleListingIds(EX_OWNER)).ownedIds).toEqual([]);
  });

  it('and the two answers match `resolveListingAccess` user for user', async () => {
    offsiteWithBlock();
    for (const userId of [RIGHTFUL, EX_OWNER, STRANGER]) {
      const inSet = (await resolveAccessibleListingIds(userId)).ownedIds.includes(PARENT);
      const isOwner = (await resolveListingAccess(PARENT, userId))?.role === 'owner';
      expect(inSet, `set and resolver disagree for user ${userId}`).toBe(isOwner);
    }
  });

  it('the sub-nav probe uses the SAME branches (offers the tab to the column owner only)', async () => {
    offsiteWithBlock();
    expect((await resolveAppsNavAccess(RIGHTFUL)).hasEditableApps).toBe(true);
    expect((await resolveAppsNavAccess(EX_OWNER)).hasEditableApps).toBe(false);
  });

  it('ON-SITE ownership in the set still resolves through the BLOCK', async () => {
    store.blockOwners.set(BLOCK, RIGHTFUL);
    putListing({ id: PARENT, kind: 'onsite', appBlockId: BLOCK, userId: EX_OWNER });
    expect((await resolveAccessibleListingIds(RIGHTFUL)).ownedIds).toEqual([PARENT]);
    expect((await resolveAccessibleListingIds(EX_OWNER)).ownedIds).toEqual([]);
  });

  it('an onsite listing with no block resolves from the column, and shadows stay excluded', async () => {
    putListing({ id: PARENT, kind: 'onsite', status: 'draft', appBlockId: null, userId: RIGHTFUL });
    putListing({
      id: SHADOW,
      kind: 'onsite',
      status: 'draft',
      appBlockId: null,
      userId: RIGHTFUL,
      revisionOfId: PARENT,
    });
    expect((await resolveAccessibleListingIds(RIGHTFUL)).ownedIds).toEqual([PARENT]);
  });

  it('🔴 the predicate is the SHARED helper — both reads pass its exact branches', async () => {
    // Structural, so "they agree" cannot be an accident of two fixtures. Both call sites
    // must hand the query the branches the helper produces, unmodified.
    offsiteWithBlock();
    await resolveAccessibleListingIds(RIGHTFUL);
    await resolveAppsNavAccess(RIGHTFUL);
    const expected = canonicalOwnerWhereBranches(RIGHTFUL);
    const many = read.appListing.findMany.mock.calls[0][0] as { where: { OR: unknown } };
    const first = read.appListing.findFirst.mock.calls[0][0] as { where: { OR: unknown } };
    expect(many.where.OR).toEqual(expected);
    expect(first.where.OR).toEqual(expected);
    // …and the helper really does carry the #3844 branch, so `toEqual` above is not
    // comparing two copies of a two-branch predicate.
    expect(expected).toHaveLength(3);
    expect(expected).toContainEqual({ kind: { not: 'onsite' }, userId: RIGHTFUL });
  });
});
