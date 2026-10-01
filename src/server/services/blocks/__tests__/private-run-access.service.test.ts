import { beforeEach, describe, expect, it } from 'vitest';

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

const { resolvePrivateRunAccess, PRIVATE_RUN_REFUSAL_REASONS } = await import(
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
  // 🔴 THESE TWO USE THE *OWNER'S* ID, NOT THE STRANGER'S, AND THAT IS THE FIX FOR A
  // REAL HOLE. They previously reused `STRANGER`, so in both rows the role gate would
  // ALSO have refused — meaning no row existed in which viewer-eligibility was the only
  // thing refusing, which is exactly where that gate does work nothing else does. With
  // the owner's id, a mutant that deletes the eligibility check lets the row through as
  // `allowed: true, audience: 'owner'` instead of quietly landing on `no-role`.
  bannedViewer: { id: OWNER, bannedAt: new Date('2026-01-01') } as Viewer,
  deletedViewer: { id: OWNER, deletedAt: new Date('2026-01-01') } as Viewer,
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
    // 🔴 `manifest.scopes` AND `approvedScopes` ARE DELIBERATELY DIFFERENT. They were
    // identical, which made this fixture unable to see the single most important mutant
    // on this surface: sourcing the clamp from the re-published MANIFEST instead of the
    // moderator-approved SNAPSHOT. With both arrays equal that swap produces the same
    // output and survives. The manifest here asks for MORE — the spend scope and a
    // private read — than the snapshot grants, which is exactly the shape of a suspended
    // publisher editing their manifest to widen their own private-run token.
    manifest: {
      name: 'Seed Explorer',
      scopes: ['ai:write:budgeted', 'collections:read:private', 'models:read:self'],
      page: { path: '/', title: 'Seed' },
      iframe: { src: 'https://seed-explorer-fixture.civit.ai', sandbox: 'allow-scripts' },
    },
    approvedScopes: ['models:read:self'],
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
  /**
   * The seat row's STORED status. Defaults to `'accepted'`.
   *
   * ⚠️ THIS FIELD WAS READ AND PASSED WITHOUT BEING DECLARED, AND IT SHIPPED GREEN.
   * `tsconfig.json` excludes `src/**` `__tests__` directories, so `pnpm typecheck` is
   * structurally blind to this file, and vitest strips types rather than checking them.
   * `tsc --strict` on the same shape reports TS2339 on the read and TS2353 on the call
   * site.
   *
   * It is not cosmetic. `seatStatus` is the field that makes the PENDING and REJECTED
   * rows non-vacuous — a typo (`seatStaus`) silently restores `stored = 'accepted'` for
   * both, and they then pass against a clamp with the `status: ACCEPTED` filter deleted,
   * which is exactly the state that fix was made to leave behind. An undeclared field is
   * a typo with no detector.
   */
  seatStatus?: string;
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
    // 🔴 THE MOCK HONOURS `where.status`, AND THAT IS NOT COSMETIC FIDELITY. It
    // previously keyed on `userId` alone, so a row's stored STATUS was invisible to it:
    // the "pending seat" and "rejected seat" rows below modelled the row being ABSENT,
    // not a row present with a non-accepted status. Deleting `status: ACCEPTED` from
    // `hasAcceptedSeat` — the consent gate those rows claim to pin — killed nothing.
    // Honouring the filter is what makes them assert what their names say.
    db.appCollaborator.findFirst.mockImplementation(async (args: any) => {
      const w = args?.where ?? {};
      if (opts.seatFor == null) return null;
      if (w.userId !== opts.seatFor) return null;
      // The row EXISTS with `opts.seatStatus`; the query only matches when it asks for
      // that status. `hasAcceptedSeat` asks for `'accepted'`.
      const stored = opts.seatStatus ?? 'accepted';
      if (w.status !== undefined && w.status !== stored) return null;
      return { userId: opts.seatFor };
    });
    // 🔴 KEYED ON `where.id`, BECAUSE THE PREDICATE NOW READS `users` TWICE — once for
    // the VIEWER (the authoritative soft-delete/ban re-read, moved in from the mint to
    // close an SSR↔mint asymmetry) and once for the OWNER (the publisher-ban gate). A
    // single `mockResolvedValue` served both, so an `ownerBannedAt` fixture made the
    // VIEWER look banned and every owner-ban row refused for the wrong reason. Keying on
    // the id is what keeps the two reads distinguishable — the same reason `dbRead` and
    // `dbWrite` are distinct objects here.
    db.user.findUnique.mockImplementation(async (args: any) => {
      const id = args?.where?.id;
      if (id === OWNER) return { bannedAt: opts.ownerBannedAt ?? null, deletedAt: null };
      // Every other id is the viewer: eligible unless the row says otherwise.
      return { bannedAt: null, deletedAt: null };
    });
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
    seatStatus?: string;
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
      block: blockRow({
        manifest: { name: 'x', scopes: [], iframe: { src: 'https://x.civit.ai' } },
      }),
      expected: { allowed: false, reason: 'not-a-page' },
    },
    {
      name: 'UNRELATED signed-in viewer → no-role',
      viewer: viewers.stranger,
      expected: { allowed: false, reason: 'no-role' },
    },
    {
      // The row EXISTS, with `status: 'pending'`. It is the ACCEPTED filter inside
      // `hasAcceptedSeat` that refuses it — which is only observable because the seat
      // mock honours `where.status`.
      name: 'PENDING seat → no-role (the ACCEPTED filter is the consent gate)',
      viewer: viewers.editor,
      seatFor: EDITOR,
      seatStatus: 'pending',
      expected: { allowed: false, reason: 'no-role' },
    },
    {
      name: 'REJECTED seat → no-role (same filter, different stored status)',
      viewer: viewers.editor,
      seatFor: EDITOR,
      seatStatus: 'rejected',
      expected: { allowed: false, reason: 'no-role' },
    },
    {
      name: 'NO seat row at all → no-role (absence, distinct from a non-accepted row)',
      viewer: viewers.editor,
      seatFor: null,
      expected: { allowed: false, reason: 'no-role' },
    },
    {
      // 🔴 `viewer-ineligible`, NOT `owner-banned`, AND THAT IS THE TRUTH RATHER THAN A
      // CONCESSION. For the `owner` audience the viewer IS the owner, so a banned owner
      // is a banned VIEWER and gate (2) refuses before the owner-ban gate is reached.
      // This row asserted `owner-banned` while the predicate's viewer check read only
      // the SESSION; moving the authoritative re-read into the predicate made the
      // earlier gate the real refuser, which is the correct order — the ban is a fact
      // about the person making the request.
      //
      // ⚠️ CONSEQUENCE WORTH KNOWING: the `owner-banned` gate's OBSERVABLE effect is
      // therefore the EDITOR case (an unbanned collaborator on a banned publisher's
      // app). Its `audience !== 'moderator'` condition is kept rather than narrowed to
      // `=== 'editor'` because it reads as "moderators are the exception" and is
      // defence-in-depth if the viewer gate is ever reordered — but a reader should not
      // expect the owner path to exercise it.
      name: 'BANNED OWNER viewing their OWN app → viewer-ineligible (the viewer gate is earlier)',
      viewer: viewers.owner,
      ownerBannedAt: new Date('2026-09-01'),
      expected: { allowed: false, reason: 'viewer-ineligible' },
    },
    {
      // THE row that reaches `owner-banned`: the viewer is an UNBANNED editor, so gate
      // (2) passes and the publisher-ban gate is the refuser. The app itself is what was
      // taken down, which is why an innocent collaborator is refused too.
      name: 'BANNED OWNER + UNBANNED editor viewer → owner-banned (the app was taken down)',
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
      // The gate moved in from the SSR route. Placed last in the predicate because it
      // depends on nothing but the manifest.
      name: 'no iframe.src → no-iframe-src (nothing to host)',
      viewer: viewers.owner,
      block: blockRow({
        manifest: {
          name: 'Seed Explorer',
          scopes: [],
          page: { path: '/', title: 'Seed' },
          iframe: { sandbox: 'allow-scripts' },
        },
      }),
      expected: { allowed: false, reason: 'no-iframe-src' },
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
      wire({
        block: row.block,
        seatFor: row.seatFor,
        seatStatus: row.seatStatus,
        ownerBannedAt: row.ownerBannedAt,
      });
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
    // 🔴 EVERY refusal reason the predicate can produce must appear at least once — and
    // the expected set is DERIVED from the exported runtime tuple, not hand-copied.
    // Types are erased, so a hand-written list stays green when a NINTH reason is added
    // to the union and has no row, against a comment claiming completeness. Deriving is
    // what makes the claim true; `PRIVATE_RUN_REFUSAL_REASONS` is the same
    // tuple-as-source-of-truth shape `PRIVATE_RUN_AUDIENCES` uses one module over.
    expect(new Set(refused.map((r) => r.expected.reason))).toEqual(
      new Set(PRIVATE_RUN_REFUSAL_REASONS)
    );
  });
});

describe('resolvePrivateRunAccess — guard REACHABILITY [INV]', () => {
  /**
   * ⚠️ RELABELLED FROM [REG] TO [INV], and the correction is worth stating: reachability
   * is a property of the GATE ORDER, which is an invariant this code establishes rather
   * than a regression it fixes. Calling it [REG] undersold what these tests are — they
   * are the most valuable describe in the file, because a guard no fixture can reach
   * passes a mutation sweep while providing nothing, and no [REG] label can buy that.
   */
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

  it('🔴 the OWNER-BAN read is keyed on the OWNER, not the VIEWER', async () => {
    // ⚠️ THE WHOLE MATRIX ABOVE PASSES WITH THIS MUTATED, WHICH IS WHY THIS TEST EXISTS.
    // Every `user.findUnique` assertion in this file was args-blind
    // (`toHaveBeenCalled()`), so `where: { id: block.ownerUserId }` →
    // `where: { id: viewer.id }` survived all 22 rows — INCLUDING the row whose entire
    // point is that the OWNER's ban refuses an unbanned EDITOR. The service docblock
    // states the property; nothing pinned it.
    //
    // The fixture makes the two ids distinguishable on purpose: the viewer is the
    // EDITOR (4002) and the owner is OWNER (4001), so a swapped key reads a different
    // row and the assertion names which.
    wire({ seatFor: EDITOR, ownerBannedAt: null });
    await resolvePrivateRunAccess({
      by: { appBlockId: APP_BLOCK },
      viewer: viewers.editor as never,
      db: 'write',
      privateRunEnabled: true,
    });
    // The OWNER-ban read: keyed on the owner, and identifiable by its narrower select
    // (`{ bannedAt }`) — the VIEWER read legitimately asks about the editor's own id with
    // `{ deletedAt, bannedAt }`, so the id alone no longer discriminates the two.
    expect(mockWriteDb.user.findUnique).toHaveBeenCalledWith({
      where: { id: OWNER },
      select: { bannedAt: true },
    });
    // 🔴 THE DISCRIMINATING HALF: the owner-ban read must NEVER be asked about the
    // VIEWER. This is the assertion that kills `where: { id: viewer.id }`.
    expect(mockWriteDb.user.findUnique).not.toHaveBeenCalledWith({
      where: { id: EDITOR },
      select: { bannedAt: true },
    });
  });

  it('🔴 the SEAT read is keyed on the LISTING and the VIEWER, with the ACCEPTED status', async () => {
    // Same class one query over: the seat mock keyed only on `userId`, so a mutant
    // resolving the seat against the BLOCK id rather than the listing id — or dropping
    // the status filter — survived. Pin all three terms of the query.
    wire({ seatFor: EDITOR });
    await resolvePrivateRunAccess({
      by: { appBlockId: APP_BLOCK },
      viewer: viewers.editor as never,
      db: 'write',
      privateRunEnabled: true,
    });
    expect(mockWriteDb.appCollaborator.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          appListingId: LISTING,
          userId: EDITOR,
          status: 'accepted',
        }),
      })
    );
  });

  it('🔴 the OWNER-BAN gate is REACHED, and is SKIPPED for a moderator', async () => {
    // 🔴 AN EDITOR, NOT THE OWNER. For the `owner` audience the viewer IS the owner, so a
    // banned owner is refused at the earlier VIEWER gate and this guard is never
    // reached — using the owner here would have tested the wrong gate while reading as a
    // test of this one. An UNBANNED editor is the fixture that reaches it.
    wire({ seatFor: EDITOR, ownerBannedAt: new Date('2026-09-01') });
    const asEditor = await resolvePrivateRunAccess({
      by: { appBlockId: APP_BLOCK },
      viewer: viewers.editor as never,
      db: 'write',
      privateRunEnabled: true,
    });
    expect(asEditor).toEqual({ allowed: false, reason: 'owner-banned' });

    // The moderator arm must not take the OWNER read — the cheap, observable proof that
    // the skip is a real branch and not an accident of the ban value. It DOES still take
    // the VIEWER read (every audience does), so the assertion names the owner read by its
    // narrower select rather than asserting the spy was never called at all.
    for (const db of [mockDb, mockWriteDb]) db.user.findUnique.mockClear();
    const asMod = await resolvePrivateRunAccess({
      by: { appBlockId: APP_BLOCK },
      viewer: viewers.moderator as never,
      db: 'write',
      privateRunEnabled: true,
    });
    expect(asMod.allowed).toBe(true);
    expect(mockWriteDb.user.findUnique).not.toHaveBeenCalledWith({
      where: { id: OWNER },
      select: { bannedAt: true },
    });
    // …and the viewer read DID happen, so the moderator is not exempt from eligibility.
    expect(mockWriteDb.user.findUnique).toHaveBeenCalledWith({
      where: { id: MOD },
      select: { deletedAt: true, bannedAt: true },
    });
  });
});

describe('resolvePrivateRunAccess — the pool is threaded, not defaulted [REG]', () => {
  /**
   * 🔴 ONE VALUE SELECTS THE POOL FOR EVERY READ **EXCEPT ONE**, AND THE EXCEPTION IS
   * DELIBERATE. The block resolve, the role resolve and the owner-ban read all follow the
   * caller's `db`, and a `db` threaded into one but not the others is the shape where a
   * mint "reads the primary" while its role check silently reads the replica — a 403 on a
   * collaborator's first private run after a seat write, and unreproducible.
   *
   * ⚠️ THE HEADING HERE USED TO SAY "ALL THREE READS" AND THAT WAS WRONG IN THE DIRECTION
   * THAT HID A GAP. There are FOUR reads, and the authoritative viewer re-read (gate 3.5)
   * goes to `dbWrite` UNCONDITIONALLY — it opts out of the caller's pool on purpose,
   * because a soft-delete or ban that landed moments ago is exactly the case it exists to
   * catch and the replica can lag it. Round 2 found that read pointed at the replica; this
   * describe claimed to own pool selection and could not have caught it, because its only
   * `db: 'read'` row asserted nothing about `user.findUnique` on either pool.
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

  it("db: 'read' (the SSR default) sends every read to the REPLICA except the authoritative viewer re-read", async () => {
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

    // 🔴 THE GATE-3.5 EXCEPTION, AND THIS IS THE ONLY ROW THAT CAN SEE IT. Every other
    // assertion that could pin THIS read's pool sits in a `db: 'write'` row, where the
    // caller's `db` handle IS `dbWrite`, so `dbWrite.user.findUnique` ->
    // `db.user.findUnique` is a no-op there and survives. Only observable on the READ path.
    // (`mockDb` and `mockWriteDb` are distinct objects — see this file's header; what
    // coincides in a write row is the caller's pool with `dbWrite`, not the two mocks.)
    //
    // The narrower `select` is the discriminator, not the id: the OWNER-ban read
    // legitimately asks the caller's pool about a user with `{ bannedAt }`, and on an
    // owner-audience row it asks about the viewer's own id. `{ deletedAt, bannedAt }` is
    // the viewer re-read's own shape — the same technique the owner-ban row above uses in
    // the opposite direction.
    expect(mockWriteDb.user.findUnique).toHaveBeenCalledWith({
      where: { id: EDITOR },
      select: { deletedAt: true, bannedAt: true },
    });
    expect(mockDb.user.findUnique).not.toHaveBeenCalledWith({
      where: { id: EDITOR },
      select: { deletedAt: true, bannedAt: true },
    });

    // 🔴 THE OWNER-BAN READ, AS A PAIR. The positive pins that it follows the caller's pool;
    // the negative is what keeps the docblock's "every read EXCEPT ONE" true, because without
    // it the exception ledger can grow from one to two with the suite green — add a second,
    // `dbWrite`-pinned owner-ban read beside this one (the move gate 3.5 itself made, for the
    // same "a ban changes the instant it lands" argument) and nothing goes red.
    expect(mockDb.user.findUnique).toHaveBeenCalledWith({
      where: { id: OWNER },
      select: { bannedAt: true },
    });
    expect(mockWriteDb.user.findUnique).not.toHaveBeenCalledWith({
      where: { id: OWNER },
      select: { bannedAt: true },
    });
  });
});

describe('resolvePrivateRunAccess — the resolver is queried by the key it was GIVEN', () => {
  it('a slug lookup filters on blockId; an appBlockId lookup filters on id', async () => {
    // Small, but it is the difference between a moderator opening
    // `/apps/run/<slug>` and getting the right app versus a bare 404 — and a
    // swapped key is invisible in a fixture where both values are the same string.
    // (This said `/apps/private-run/<slug>` until that route was deleted and the private
    // run became a fallback inside the public one.)
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
