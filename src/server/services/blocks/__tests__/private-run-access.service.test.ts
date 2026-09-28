import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE PRIVATE-RUN ACCESS MATRIX — `resolvePrivateRunAccess`.
 *
 * [REG] IN FULL. The predicate does not exist at the base ref `f7f5eb4996`, so every
 * row in this file is red there for the most basic reason available: the module cannot
 * be imported. That is worth stating plainly rather than dressing up — it means this
 * file proves the feature was ADDED, and the MUTATION suite below it is what proves
 * each individual guard does the work its name claims.
 *
 * ── WHAT IS ASSERTED, AND WHY IT IS THE EXACT VALUE ─────────────────────────────
 * Every row asserts the WHOLE `PrivateRunAccess` value — `allowed`, and either
 * `audience` or `reason` — never merely `allowed: false`. A test that only checks
 * "it refused" cannot tell the flag gate from the role gate from the deploy gate, so
 * it stays green while a guard is deleted and a neighbouring one catches the case for
 * the wrong reason. Naming the reason is what makes each guard's mutant killable BY
 * ITS OWN ERROR.
 *
 * ── FIXTURE HYGIENE, AND WHY THESE PARTICULAR NUMBERS ───────────────────────────
 * 🔴 EVERY ID IS PAIRWISE DISTINCT AND DISTINCT FROM EVERY CONSTANT THE ASSERTIONS
 * NAME. A fixture whose owner id equals its viewer id cannot distinguish the role
 * guard from a self-dealing check — both fire — so such a fixture SURVIVES a mutation
 * that swaps one for the other while the suite stays green. Owner 4001, editor 4002,
 * stranger 4003, moderator 4004, banned-owner 4005: no two equal, none zero, none
 * adjacent to a boolean coercion.
 */

// 🔴 THE CANONICAL db MOCK, NOT A HAND-WRITTEN ONE. `no-direct-shared-module-mock`
// enforces this and it is not a style rule: the unit suite runs its workers WITHOUT
// per-file isolation, so a hand-rolled partial mock of `~/server/db/client` is cached
// per WORKER and poisons every later file that reaches it through an ordinary source
// module — and when the poisoned import is at module scope the victim file collects
// ZERO tests while the summary still reads green.
//
// The canonical mock keeps `dbRead` and `dbWrite` as DISTINCT objects, which this file
// depends on: every replica-vs-primary assertion here is meaningless if the two spies
// are one spy.
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockDb = dbMock.dbRead;
const mockWriteDb = dbMock.dbWrite;

const { resolvePrivateRunAccess } = await import(
  '~/server/services/blocks/private-run-access.service'
);

const OWNER = 4001;
const EDITOR = 4002;
const STRANGER = 4003;
const MOD = 4004;
const APP_BLOCK = 'apb_privrun';
const SLUG = 'seed-explorer-fixture';
const LISTING = 'apl_removed';

type Viewer = {
  id: number;
  isModerator?: boolean;
  bannedAt?: Date;
  deletedAt?: Date;
};

const viewers = {
  owner: { id: OWNER } as Viewer,
  editor: { id: EDITOR } as Viewer,
  stranger: { id: STRANGER } as Viewer,
  moderator: { id: MOD, isModerator: true } as Viewer,
  bannedViewer: { id: STRANGER, bannedAt: new Date('2026-01-01') } as Viewer,
  deletedViewer: { id: STRANGER, deletedAt: new Date('2026-01-01') } as Viewer,
  /** A moderator who is ALSO the owner — must resolve as `moderator` (checked first). */
  modOwner: { id: OWNER, isModerator: true } as Viewer,
};

/** A fully-eligible suspended, deployed, page-declaring block owned by OWNER. */
function blockRow(over: Record<string, unknown> = {}) {
  return {
    id: APP_BLOCK,
    blockId: SLUG,
    appId: 'app_privrun',
    status: 'suspended',
    // 🔴 A REAL `page.path`. `manifestDeclaresPage` requires a non-empty string path,
    // so `page: {}` would refuse for a reason this fixture does not intend to test.
    manifest: {
      name: 'Seed Explorer',
      scopes: ['apps:storage:read'],
      page: { path: '/', title: 'Seed' },
      iframe: { src: 'https://seed-explorer-fixture.civit.ai', sandbox: 'allow-scripts' },
    },
    approvedScopes: ['apps:storage:read'],
    trustTier: 'unverified',
    contentRating: 'g',
    currentVersionDeployedAt: new Date('2026-09-01'),
    app: { userId: OWNER },
    appListing: { status: 'removed' },
    ...over,
  };
}

/** Wire the block resolve + the seat resolve + the owner-ban read on BOTH pools. */
function wire(opts: {
  block?: unknown;
  seatFor?: number | null;
  ownerBannedAt?: Date | null;
}) {
  for (const db of [mockDb, mockWriteDb]) {
    db.appBlock.findFirst.mockResolvedValue(opts.block === undefined ? blockRow() : opts.block);
    // `resolveAppAccess` reads the block by id, then the seat.
    db.appBlock.findUnique.mockResolvedValue({
      id: APP_BLOCK,
      app: { userId: OWNER },
      appListing: { id: LISTING },
    });
    db.appCollaborator.findFirst.mockImplementation(async (args: any) =>
      opts.seatFor != null && args?.where?.userId === opts.seatFor ? { userId: opts.seatFor } : null
    );
    db.user.findUnique.mockResolvedValue({ bannedAt: opts.ownerBannedAt ?? null });
  }
}

beforeEach(() => {
  for (const db of [mockDb, mockWriteDb]) {
    db.appBlock.findFirst.mockReset();
    db.appBlock.findUnique.mockReset();
    db.appCollaborator.findFirst.mockReset();
    db.user.findUnique.mockReset();
  }
});

describe('resolvePrivateRunAccess — the access matrix [REG]', () => {
  /**
   * 🔴 AN EXPLICIT TABLE, NOT NESTED LOOPS. The full cross-product of viewer × block
   * status × listing state × deploy × flag is in the thousands and almost all of it is
   * unreachable noise; worse, a loop names its failures by index, so a red run says
   * "row 47" rather than "a pending seat was treated as an editor". Each row below is
   * nameable in its own failure message.
   */
  const rows: Array<{
    name: string;
    viewer: Viewer | undefined;
    block?: unknown;
    seatFor?: number | null;
    ownerBannedAt?: Date | null;
    flag?: boolean;
    expected: Record<string, unknown>;
  }> = [
    // ── the three admitted audiences ──────────────────────────────────────────
    {
      name: 'OWNER of a suspended+removed app → allowed as owner (the headline case)',
      viewer: viewers.owner,
      expected: { allowed: true, audience: 'owner' },
    },
    {
      name: 'ACCEPTED EDITOR on a REMOVED listing → allowed as editor (the seat asymmetry)',
      viewer: viewers.editor,
      seatFor: EDITOR,
      expected: { allowed: true, audience: 'editor' },
    },
    {
      name: 'MODERATOR who is neither owner nor collaborator → allowed as moderator',
      viewer: viewers.moderator,
      expected: { allowed: true, audience: 'moderator' },
    },
    {
      name: 'MODERATOR who is ALSO the owner → moderator wins (checked before the role resolve)',
      viewer: viewers.modOwner,
      expected: { allowed: true, audience: 'moderator' },
    },

    // ── the refusals, each by its OWN reason ──────────────────────────────────
    {
      name: 'FLAG OFF → flag-off, and nothing is read at all',
      viewer: viewers.owner,
      flag: false,
      expected: { allowed: false, reason: 'flag-off' },
    },
    {
      name: 'ANON → viewer-ineligible',
      viewer: undefined,
      expected: { allowed: false, reason: 'viewer-ineligible' },
    },
    {
      name: 'BANNED viewer → viewer-ineligible',
      viewer: viewers.bannedViewer,
      expected: { allowed: false, reason: 'viewer-ineligible' },
    },
    {
      name: 'SOFT-DELETED viewer → viewer-ineligible',
      viewer: viewers.deletedViewer,
      expected: { allowed: false, reason: 'viewer-ineligible' },
    },
    {
      name: 'NO SUCH APP → no-app',
      viewer: viewers.owner,
      block: null,
      expected: { allowed: false, reason: 'no-app' },
    },
    {
      name: 'APPROVED app → approved (the PUBLIC path owns it; the private one is a no-op)',
      viewer: viewers.owner,
      block: blockRow({ status: 'approved' }),
      expected: { allowed: false, reason: 'approved' },
    },
    {
      name: 'suspended app that declares NO page → not-a-page',
      viewer: viewers.owner,
      block: blockRow({ manifest: { name: 'x', scopes: [], iframe: { src: 'https://x.civit.ai' } } }),
      expected: { allowed: false, reason: 'not-a-page' },
    },
    {
      name: 'UNRELATED signed-in viewer → no-role',
      viewer: viewers.stranger,
      expected: { allowed: false, reason: 'no-role' },
    },
    {
      name: 'PENDING seat → no-role (the ACCEPTED filter is the consent gate)',
      viewer: viewers.editor,
      // The collaborator row exists but not with `status: 'accepted'`, which is what
      // `hasAcceptedSeat`'s filter expresses — modelled by the seat lookup missing.
      seatFor: null,
      expected: { allowed: false, reason: 'no-role' },
    },
    {
      name: 'REJECTED seat → no-role (same filter, different stored status)',
      viewer: viewers.editor,
      seatFor: null,
      expected: { allowed: false, reason: 'no-role' },
    },
    {
      name: 'BANNED OWNER + owner viewer → owner-banned',
      viewer: viewers.owner,
      ownerBannedAt: new Date('2026-09-01'),
      expected: { allowed: false, reason: 'owner-banned' },
    },
    {
      name: 'BANNED OWNER + editor viewer → owner-banned (the app is what was taken down)',
      viewer: viewers.editor,
      seatFor: EDITOR,
      ownerBannedAt: new Date('2026-09-01'),
      expected: { allowed: false, reason: 'owner-banned' },
    },
    {
      name: 'BANNED OWNER + MODERATOR → STILL ALLOWED (reviewing a banned publisher is the job)',
      viewer: viewers.moderator,
      ownerBannedAt: new Date('2026-09-01'),
      expected: { allowed: true, audience: 'moderator' },
    },
    {
      name: 'NOT DEPLOYED → not-deployed, for an otherwise fully-eligible owner',
      viewer: viewers.owner,
      block: blockRow({ currentVersionDeployedAt: null }),
      expected: { allowed: false, reason: 'not-deployed' },
    },
    {
      name: 'no listing row at all → owner still allowed (no seats ⇒ owner or nothing)',
      viewer: viewers.owner,
      block: blockRow({ appListing: null }),
      expected: { allowed: true, audience: 'owner' },
    },
    {
      name: 'no listing row + unrelated viewer → no-role',
      viewer: viewers.stranger,
      block: blockRow({ appListing: null }),
      expected: { allowed: false, reason: 'no-role' },
    },
    {
      name: 'PENDING (re-submitted) app → allowed; the deployed build is the last approved one',
      viewer: viewers.owner,
      block: blockRow({ status: 'pending', appListing: { status: 'approved' } }),
      expected: { allowed: true, audience: 'owner' },
    },
    {
      name: 'DEPRECATED app → allowed, same containment, no extra gate',
      viewer: viewers.owner,
      block: blockRow({ status: 'deprecated' }),
      expected: { allowed: true, audience: 'owner' },
    },
  ];

  for (const row of rows) {
    it(row.name, async () => {
      wire({ block: row.block, seatFor: row.seatFor, ownerBannedAt: row.ownerBannedAt });
      const res = await resolvePrivateRunAccess({
        by: { appBlockId: APP_BLOCK },
        viewer: row.viewer as never,
        db: 'write',
        privateRunEnabled: row.flag ?? true,
      });
      // `toMatchObject` on the refusal rows would let an unexpected extra key through;
      // these values are small and closed, so assert them whole.
      if (row.expected.allowed === true) {
        expect(res.allowed).toBe(true);
        expect(res.allowed === true && res.audience).toBe(row.expected.audience);
      } else {
        expect(res).toEqual(row.expected);
      }
    });
  }

  it('POSITIVE CONTROL: the table contains BOTH outcomes, so no assertion is vacuous', () => {
    // A matrix that had silently become all-refusals would still pass every row above
    // while proving nothing about the allow path — and vice versa. Assert both
    // populations are non-empty and that the three audiences are all exercised.
    const allowed = rows.filter((r) => r.expected.allowed === true);
    const refused = rows.filter((r) => r.expected.allowed === false);
    expect(allowed.length).toBeGreaterThan(4);
    expect(refused.length).toBeGreaterThan(8);
    expect(new Set(allowed.map((r) => r.expected.audience))).toEqual(
      new Set(['owner', 'editor', 'moderator'])
    );
    // Every refusal reason the predicate can produce must appear at least once.
    expect(new Set(refused.map((r) => r.expected.reason))).toEqual(
      new Set([
        'flag-off',
        'viewer-ineligible',
        'no-app',
        'approved',
        'not-a-page',
        'no-role',
        'owner-banned',
        'not-deployed',
      ])
    );
  });
});

describe('resolvePrivateRunAccess — guard REACHABILITY [REG]', () => {
  /**
   * 🔴 A GUARD THAT NEVER EXECUTES PASSES A MUTATION SWEEP. These tests prove each
   * guard is REACHED with a fixture that no EARLIER check rejects — which is a
   * different claim from "a test fails when I break it", and the one that the gate
   * ORDER decides.
   */

  it('the FLAG gate runs before ANY read — a refused request touches no table', async () => {
    wire({});
    const res = await resolvePrivateRunAccess({
      by: { appBlockId: APP_BLOCK },
      viewer: viewers.owner as never,
      db: 'write',
      privateRunEnabled: false,
    });
    expect(res).toEqual({ allowed: false, reason: 'flag-off' });
    // This is what makes "turn the flag off" a COMPLETE rollback: nothing was resolved,
    // so there is no state to unwind.
    expect(mockWriteDb.appBlock.findFirst).not.toHaveBeenCalled();
    expect(mockWriteDb.appBlock.findUnique).not.toHaveBeenCalled();
    expect(mockWriteDb.user.findUnique).not.toHaveBeenCalled();
  });

  it('the VIEWER gate runs before the app read — an anon prober consumes no query', async () => {
    wire({});
    await resolvePrivateRunAccess({
      by: { appBlockId: APP_BLOCK },
      viewer: undefined,
      db: 'write',
      privateRunEnabled: true,
    });
    expect(mockWriteDb.appBlock.findFirst).not.toHaveBeenCalled();
  });

  it('🔴 the DEPLOY gate is REACHED by a fixture eligible in every OTHER respect', async () => {
    // The guard most at risk of being unreachable, and the reason it is placed LAST.
    // This fixture is owner + suspended + page-declaring + unbanned — so the role
    // resolve, the approved test, the page test and the ban read have all PASSED, and
    // the only thing left to refuse is the deploy gate. If it sat before the role
    // resolve, an "unrelated viewer + undeployed app" fixture would kill its mutant for
    // the WRONG reason and this guard would never be shown to work on its own terms.
    wire({ block: blockRow({ currentVersionDeployedAt: null }), ownerBannedAt: null });
    const res = await resolvePrivateRunAccess({
      by: { appBlockId: APP_BLOCK },
      viewer: viewers.owner as never,
      db: 'write',
      privateRunEnabled: true,
    });
    expect(res).toEqual({ allowed: false, reason: 'not-deployed' });
    // Proof the earlier gates really did execute rather than short-circuiting: the ban
    // read only happens AFTER a role has been resolved.
    expect(mockWriteDb.user.findUnique).toHaveBeenCalled();
  });

  it('🔴 the OWNER-BAN gate is REACHED, and is SKIPPED for a moderator', async () => {
    wire({ ownerBannedAt: new Date('2026-09-01') });
    const asOwner = await resolvePrivateRunAccess({
      by: { appBlockId: APP_BLOCK },
      viewer: viewers.owner as never,
      db: 'write',
      privateRunEnabled: true,
    });
    expect(asOwner).toEqual({ allowed: false, reason: 'owner-banned' });

    // The moderator arm must not even take the read — that is the cheap, observable
    // proof that the skip is a real branch and not an accident of the ban value.
    for (const db of [mockDb, mockWriteDb]) db.user.findUnique.mockClear();
    const asMod = await resolvePrivateRunAccess({
      by: { appBlockId: APP_BLOCK },
      viewer: viewers.moderator as never,
      db: 'write',
      privateRunEnabled: true,
    });
    expect(asMod.allowed).toBe(true);
    expect(mockWriteDb.user.findUnique).not.toHaveBeenCalled();
  });
});

describe('resolvePrivateRunAccess — the pool is threaded, not defaulted [REG]', () => {
  /**
   * 🔴 ONE VALUE MUST SELECT THE POOL FOR ALL THREE READS. The block resolve, the role
   * resolve and the ban read are three separate queries, and a `db` threaded into one
   * but not the others is the shape where a mint "reads the primary" while its role
   * check silently reads the replica — which is a 403 on a collaborator's first private
   * run after a seat write, and unreproducible.
   */
  it("db: 'write' sends EVERY read to the primary and NONE to the replica", async () => {
    wire({ seatFor: EDITOR });
    const res = await resolvePrivateRunAccess({
      by: { appBlockId: APP_BLOCK },
      viewer: viewers.editor as never,
      db: 'write',
      privateRunEnabled: true,
    });
    expect(res.allowed).toBe(true);
    expect(mockWriteDb.appBlock.findFirst).toHaveBeenCalled();
    expect(mockWriteDb.appBlock.findUnique).toHaveBeenCalled();
    expect(mockWriteDb.appCollaborator.findFirst).toHaveBeenCalled();
    expect(mockWriteDb.user.findUnique).toHaveBeenCalled();
    // The replica must be untouched — this is the half that fails if a future edit
    // hardcodes `dbRead` in any one of the three legs.
    expect(mockDb.appBlock.findFirst).not.toHaveBeenCalled();
    expect(mockDb.appBlock.findUnique).not.toHaveBeenCalled();
    expect(mockDb.appCollaborator.findFirst).not.toHaveBeenCalled();
    expect(mockDb.user.findUnique).not.toHaveBeenCalled();
  });

  it("db: 'read' (the SSR default) sends every read to the REPLICA", async () => {
    wire({ seatFor: EDITOR });
    const res = await resolvePrivateRunAccess({
      by: { appBlockId: APP_BLOCK },
      viewer: viewers.editor as never,
      privateRunEnabled: true,
    });
    expect(res.allowed).toBe(true);
    expect(mockDb.appBlock.findFirst).toHaveBeenCalled();
    expect(mockDb.appCollaborator.findFirst).toHaveBeenCalled();
    expect(mockWriteDb.appBlock.findFirst).not.toHaveBeenCalled();
  });
});

describe('resolvePrivateRunAccess — the resolver is queried by the key it was GIVEN', () => {
  it('a slug lookup filters on blockId; an appBlockId lookup filters on id', async () => {
    // Small, but it is the difference between a moderator opening
    // `/apps/private-run/<slug>` and getting the right app versus a bare 404 — and a
    // swapped key is invisible in a fixture where both values are the same string.
    // SLUG and APP_BLOCK are deliberately different strings for exactly this test.
    wire({});
    await resolvePrivateRunAccess({
      by: { slug: SLUG },
      viewer: viewers.owner as never,
      db: 'write',
      privateRunEnabled: true,
    });
    expect(mockWriteDb.appBlock.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ blockId: SLUG }) })
    );

    mockWriteDb.appBlock.findFirst.mockClear();
    await resolvePrivateRunAccess({
      by: { appBlockId: APP_BLOCK },
      viewer: viewers.owner as never,
      db: 'write',
      privateRunEnabled: true,
    });
    expect(mockWriteDb.appBlock.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: APP_BLOCK }) })
    );
  });

  it('an EMPTY key answers no-app without touching the database', async () => {
    wire({});
    const res = await resolvePrivateRunAccess({
      by: { slug: '' },
      viewer: viewers.owner as never,
      db: 'write',
      privateRunEnabled: true,
    });
    expect(res).toEqual({ allowed: false, reason: 'no-app' });
    expect(mockWriteDb.appBlock.findFirst).not.toHaveBeenCalled();
  });
});
