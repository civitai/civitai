import { beforeEach, describe, expect, it } from 'vitest';

/**
 * 🔴 THE BEHAVIOURAL HALF OF THE SSR⇄MINT SEAM — the half a structural ledger cannot be.
 *
 * [REG]. `private-run-access.call-site-ledger.test.ts` COUNTS the two call sites. It
 * type-checks past a wrong argument: it cannot see a caller that passes the wrong slug,
 * the wrong pool, or a hardcoded flag. This file exercises the RELATIONSHIP instead —
 * one fixture, driven through the real predicate twice with the two callers' actual
 * argument shapes, asserting the two answers agree.
 *
 * ── WHY AGREEMENT IS THE PROPERTY, RATHER THAN CORRECTNESS ──────────────────────
 * The bug this feature is built to avoid is not "the gate is wrong" — it is "the two
 * gates are DIFFERENT". The dev-tunnel SSR route mounted an owned app at any status
 * while the page mint required `approved`, so the page rendered and then could not
 * authenticate, and `tryDevTunnelOwnedNonApprovedMint` exists only to patch that over.
 * A disagreement of either polarity is a defect:
 *   - SSR allows + mint refuses ⇒ the app renders and then cannot authenticate, which
 *     the host surfaces as "Couldn't authenticate this app";
 *   - SSR refuses + mint allows ⇒ a token is mintable for a page nobody can reach,
 *     which is a capability with no UI and no audit trail.
 *
 * 🔴 THE TWO CALLS DIFFER EXACTLY AS THE PRODUCTION CALLERS DIFFER, which is the whole
 * point rather than incidental fidelity: SSR looks the app up BY SLUG against the
 * REPLICA, the mint BY appBlockId against the PRIMARY. Those are two different queries
 * over two different pools, and "they cannot disagree" is a claim that has to be
 * exercised across both axes at once.
 */

// 🔴 THE CANONICAL db MOCK — required by `no-direct-shared-module-mock`, and not a style
// rule: the unit suite runs its workers WITHOUT per-file isolation, so a hand-rolled
// partial mock of the db client is cached per WORKER and poisons every later file that
// reaches it through an ordinary source module. When the poisoned import sits at module
// scope the victim file collects ZERO tests while the run still reads green.
//
// The canonical mock keeps the read and write clients as DISTINCT objects, which this
// file depends on absolutely: the entire point here is that the SSR call reads the
// replica and the mint call reads the primary, and if the two spies were one spy the
// agreement it asserts would be two identical calls agreeing with themselves.
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockDb = dbMock.dbRead;
const mockWriteDb = dbMock.dbWrite;

const { resolvePrivateRunAccess } = await import(
  '~/server/services/blocks/private-run-access.service'
);

const OWNER = 5001;
const EDITOR = 5002;
const STRANGER = 5003;
const MOD = 5004;
const APP_BLOCK = 'apb_seam';
const SLUG = 'seam-fixture-app';

function blockRow(over: Record<string, unknown> = {}) {
  return {
    id: APP_BLOCK,
    blockId: SLUG,
    appId: 'app_seam',
    status: 'suspended',
    manifest: {
      name: 'Seam Fixture',
      scopes: ['models:read:self'],
      page: { path: '/', title: 'Seam' },
      iframe: { src: 'https://seam-fixture-app.civit.ai', sandbox: 'allow-scripts' },
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

/**
 * Wire BOTH pools identically.
 *
 * 🔴 IDENTICAL ON PURPOSE, AND THAT IS WHAT MAKES THE TEST MEAN SOMETHING. The two
 * pools are separate spies so a dropped `db` argument is observable, but they must
 * return the SAME rows — otherwise a disagreement between SSR and the mint could be
 * explained by the fixture rather than by the code, and the test would be measuring its
 * own scaffolding. The `findFirst` mock also honours the WHERE clause, so a caller that
 * looked the app up by the wrong key gets null rather than the row by accident.
 */
function wire(opts: { block?: unknown; seatFor?: number | null; ownerBannedAt?: Date | null }) {
  const row = opts.block === undefined ? blockRow() : opts.block;
  for (const db of [mockDb, mockWriteDb]) {
    db.appBlock.findFirst.mockImplementation(async (args: any) => {
      if (row == null) return null;
      const w = args?.where ?? {};
      // Honour whichever key the caller used; refuse a key that does not match.
      if (w.blockId !== undefined) return w.blockId === (row as any).blockId ? row : null;
      if (w.id !== undefined) return w.id === (row as any).id ? row : null;
      return null;
    });
    db.appBlock.findUnique.mockResolvedValue({
      id: APP_BLOCK,
      app: { userId: OWNER },
      appListing: { id: 'apl_seam' },
    });
    db.appCollaborator.findFirst.mockImplementation(async (args: any) =>
      opts.seatFor != null && args?.where?.userId === opts.seatFor ? { userId: opts.seatFor } : null
    );
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

type Scenario = {
  name: string;
  viewer: unknown;
  block?: unknown;
  seatFor?: number | null;
  ownerBannedAt?: Date | null;
  flag?: boolean;
  expectAllowed: boolean;
};

const SCENARIOS: Scenario[] = [
  { name: 'owner, suspended, deployed', viewer: { id: OWNER }, expectAllowed: true },
  {
    name: 'accepted editor on a removed listing',
    viewer: { id: EDITOR },
    seatFor: EDITOR,
    expectAllowed: true,
  },
  { name: 'moderator', viewer: { id: MOD, isModerator: true }, expectAllowed: true },
  {
    name: 'moderator on a banned publisher app',
    viewer: { id: MOD, isModerator: true },
    ownerBannedAt: new Date('2026-09-01'),
    expectAllowed: true,
  },
  { name: 'unrelated signed-in viewer', viewer: { id: STRANGER }, expectAllowed: false },
  { name: 'anonymous', viewer: undefined, expectAllowed: false },
  {
    name: 'banned viewer',
    viewer: { id: STRANGER, bannedAt: new Date('2026-01-01') },
    expectAllowed: false,
  },
  {
    // 🔴 THE ROW THAT EXERCISES THE `!= null` CONTROL. `bannedAt: null` is the shape
    // Prisma returns for an unbanned user and an entirely natural `SessionUser`, and
    // production tests TRUTHINESS, so this viewer REACHES the resolve. Under the old
    // `!== undefined` control it was classified as refused-by-a-free-gate and this row
    // FAILED on the `else` branch's "neither pool was touched" assertion — a false
    // failure pointing at the code rather than at the control. Owner audience so the row
    // is allowed and both pools are genuinely exercised: it is among the rows that kill
    // the mutant pinning the block resolve to one pool (`{ db: pool }` -> `{ db: 'read' }`),
    // which fails here with the control's own "the mint call must read the PRIMARY".
    name: 'owner whose session carries an explicit bannedAt: null',
    viewer: { id: OWNER, bannedAt: null, deletedAt: null },
    expectAllowed: true,
  },
  { name: 'flag off', viewer: { id: OWNER }, flag: false, expectAllowed: false },
  { name: 'no such app', viewer: { id: OWNER }, block: null, expectAllowed: false },
  {
    name: 'approved app (the public path owns it)',
    viewer: { id: OWNER },
    block: blockRow({ status: 'approved' }),
    expectAllowed: false,
  },
  {
    name: 'undeployed app',
    viewer: { id: OWNER },
    block: blockRow({ currentVersionDeployedAt: null }),
    expectAllowed: false,
  },
  {
    // Refused as `viewer-ineligible` rather than `owner-banned` — for the owner audience
    // the viewer IS the owner, so the earlier viewer gate is the refuser. The agreement
    // assertion below compares the REASON, so this scenario also pins that both callers
    // agree about WHICH gate refused, not merely that they both refused.
    name: 'banned publisher, owner viewer (refused at the VIEWER gate)',
    viewer: { id: OWNER },
    ownerBannedAt: new Date('2026-09-01'),
    expectAllowed: false,
  },
  {
    name: 'banned publisher, UNBANNED editor viewer (refused at the OWNER-ban gate)',
    viewer: { id: EDITOR },
    seatFor: EDITOR,
    ownerBannedAt: new Date('2026-09-01'),
    expectAllowed: false,
  },
  {
    name: 'pending (re-submitted) app',
    viewer: { id: OWNER },
    block: blockRow({ status: 'pending' }),
    expectAllowed: true,
  },
  {
    // 🔴 THE GATE THIS CHANGE MOVED, AND IT HAD NO ROW HERE. `no-iframe-src` was applied
    // by the SSR route AFTER the predicate while the mint applied no equivalent — a live
    // SSR↔mint disagreement — and moving it into the predicate is the fix. This seam
    // test is the ONLY artifact that can prove the two no longer disagree, and the
    // private route's own comment cites it as the reason its remaining narrowing check is
    // "not counted as a gate". Without this row that citation was false, and re-adding an
    // iframeSrc check to one caller only would have kept the seam green.
    name: 'no iframe.src (the gate this change moved into the predicate)',
    viewer: { id: OWNER },
    block: blockRow({
      manifest: {
        name: 'Seam Fixture',
        scopes: ['models:read:self'],
        page: { path: '/', title: 'Seam' },
        iframe: { sandbox: 'allow-scripts' },
      },
    }),
    expectAllowed: false,
  },
];

describe('SSR and the mint cannot disagree [REG]', () => {
  for (const s of SCENARIOS) {
    it(`agree for: ${s.name}`, async () => {
      wire({ block: s.block, seatFor: s.seatFor, ownerBannedAt: s.ownerBannedAt });
      // The SSR caller's shape: BY SLUG, against the REPLICA.
      const ssr = await resolvePrivateRunAccess({
        by: { slug: SLUG },
        viewer: s.viewer as never,
        db: 'read',
        privateRunEnabled: s.flag ?? true,
      });
      // The MINT caller's shape: BY appBlockId, against the PRIMARY.
      const mint = await resolvePrivateRunAccess({
        by: { appBlockId: APP_BLOCK },
        viewer: s.viewer as never,
        db: 'write',
        privateRunEnabled: s.flag ?? true,
      });

      expect(ssr.allowed, 'SSR and the mint must agree on ALLOWED').toBe(mint.allowed);
      expect(ssr.allowed, 'and the fixture must produce the expected polarity').toBe(
        s.expectAllowed
      );
      if (ssr.allowed && mint.allowed) {
        // Agreeing on "yes" is not enough — they must agree on WHICH audience, because
        // the audience decides the scope clamp and the runtime read-only belt. An SSR
        // that said `owner` while the mint said `editor` would render a full-power page
        // over a read-only token.
        expect(ssr.audience, 'they must agree on the AUDIENCE').toBe(mint.audience);
      } else if (!ssr.allowed && !mint.allowed) {
        expect(ssr.reason, 'they must agree on the REASON').toBe(mint.reason);
      }

      // 🔴 THE TWO-POOL CONTROL, IN THIS BODY RATHER THAN ITS OWN TEST. If the `db`
      // argument were dropped on either side, both calls would hit whichever pool is
      // the default — and two IDENTICAL calls always agree, so the whole assertion above
      // would be trivially true while proving nothing. This is what makes the agreement
      // a claim about two pools.
      //
      // ⚠️ It lives here because it cannot live in a separate `it`: `beforeEach` resets
      // the spies, so a standalone test would read zero calls and pass or fail for
      // reasons unrelated to the code. The first draft of this file made exactly that
      // mistake and the assertion failed with "expected vi.fn() to be called at least
      // once" — a test that was measuring its own scaffolding.
      // 🔴 THIS CONTROL HAS NOW BEEN WRONG TWICE, IN OPPOSITE WAYS, AND BOTH FAILURES
      // ARE WORTH KEEPING ON THE RECORD — because each was caused by a change to the
      // gate order, which is precisely what a seam test must survive.
      //
      //   v1 derived it from the FIXTURE (`flag on && viewer && !viewer.bannedAt`). That
      //      broke when the authoritative viewer re-read was added BEFORE the block
      //      resolve: a banned owner then refused without reading any pool, while the
      //      fixture said it would.
      //   v2 derived it from the RESULT (`reason not in ['flag-off','viewer-ineligible']`).
      //      That broke when the same read MOVED to after the block resolve: a
      //      DB-detected `viewer-ineligible` now does read the block first, so the reason
      //      alone stopped distinguishing the two viewer gates.
      //
      // The durable form is neither: it asks the only question that actually decides the
      // matter — CAN ANY GATE REFUSE BEFORE THE BLOCK READ? Today exactly two can, and
      // both are FREE (no query): the flag, and the SESSION pre-filter. Every DB-backed
      // gate, including the authoritative viewer re-read, necessarily runs after. So this
      // is derived from the two fixture facts those two gates read, and nothing else.
      const sessionViewer = s.viewer as { bannedAt?: Date; deletedAt?: Date } | undefined;
      const refusedByAFreeGate =
        (s.flag ?? true) === false ||
        sessionViewer == null ||
        // 🔴 `!= null`, NOT `!== undefined`, because production tests TRUTHINESS
        // (`viewer.bannedAt || viewer.deletedAt`). A `bannedAt: null` fixture — the shape
        // Prisma returns for an unbanned user, and an entirely natural `SessionUser` —
        // REACHES the resolve in production, while `!== undefined` classified it as
        // refused-by-a-free-gate.
        //
        // ⚠️ WHAT THAT MISCLASSIFICATION ACTUALLY DID, MEASURED RATHER THAN ASSUMED — and
        // the first version of this comment got it wrong in the direction that flatters the
        // fix. It does NOT silently skip the pool assertions: the `else` branch below
        // asserts NEITHER pool was touched, so a misclassified row FAILS, loudly, with
        // "expected vi.fn() to not be called at all, but actually been called 1 times".
        // Verified by reverting this line and running the row added for it. So the defect
        // was a FALSE FAILURE waiting for someone to write a natural fixture, not a hole —
        // still worth fixing, because a control that misclassifies blocks legitimate rows
        // and misattributes the failure to the code under test, but not a coverage gap.
        // Stated precisely because "it would have silently skipped" is exactly the kind of
        // claim this file exists to stop shipping.
        sessionViewer.bannedAt != null ||
        sessionViewer.deletedAt != null;
      const reachesTheResolve = !refusedByAFreeGate;
      if (reachesTheResolve) {
        expect(mockDb.appBlock.findFirst, 'the SSR call must read the REPLICA').toHaveBeenCalled();
        expect(
          mockWriteDb.appBlock.findFirst,
          'the mint call must read the PRIMARY'
        ).toHaveBeenCalled();
      } else {
        // The complementary half: a gate that refuses before the resolve must touch
        // NEITHER pool, on both surfaces.
        expect(mockDb.appBlock.findFirst).not.toHaveBeenCalled();
        expect(mockWriteDb.appBlock.findFirst).not.toHaveBeenCalled();
      }
    });
  }

  it('🔴 POSITIVE CONTROL: the scenario set contains BOTH polarities', () => {
    // "They agree" is a claim about a set of identical answers unless the set spans both
    // outcomes. Without this, a predicate that refused everything would satisfy every
    // row above.
    expect(SCENARIOS.some((s) => s.expectAllowed)).toBe(true);
    expect(SCENARIOS.some((s) => !s.expectAllowed)).toBe(true);
    expect(SCENARIOS.filter((s) => s.expectAllowed).length).toBeGreaterThan(3);
    expect(SCENARIOS.filter((s) => !s.expectAllowed).length).toBeGreaterThan(5);
  });

  it('🔴 NEGATIVE CONTROL: the harness CAN observe a real disagreement', async () => {
    // ⚠️ THIS REPLACED A CONTROL THAT TESTED VITEST. The first version built two object
    // literals and asserted `expect(() => expect(a.allowed).toBe(b.allowed)).toThrow()`
    // — i.e. that `expect` throws on unequal values. It touched neither the predicate,
    // nor the wiring, nor the two pools, so it could not tell a working harness from one
    // wired to nothing, which is precisely the claim a negative control makes.
    //
    // This drives the REAL predicate through the REAL wiring with the two pools
    // DISAGREEING — the replica sees the app, the primary does not — and asserts the
    // comparison the per-scenario rows use actually goes red. That is the only form of
    // this control that proves anything about this file.
    const row = blockRow();
    mockDb.appBlock.findFirst.mockImplementation(async () => row);
    mockWriteDb.appBlock.findFirst.mockImplementation(async () => null);
    for (const db of [mockDb, mockWriteDb]) {
      db.appBlock.findUnique.mockResolvedValue({
        id: APP_BLOCK,
        app: { userId: OWNER },
        appListing: { id: 'apl_seam' },
      });
      db.appCollaborator.findFirst.mockResolvedValue(null);
      db.user.findUnique.mockResolvedValue({ bannedAt: null });
    }

    const ssr = await resolvePrivateRunAccess({
      by: { slug: SLUG },
      viewer: { id: OWNER } as never,
      db: 'read',
      privateRunEnabled: true,
    });
    const mint = await resolvePrivateRunAccess({
      by: { appBlockId: APP_BLOCK },
      viewer: { id: OWNER } as never,
      db: 'write',
      privateRunEnabled: true,
    });

    // The pools really did diverge, which is what makes the next assertion meaningful.
    expect(ssr.allowed).toBe(true);
    expect(mint.allowed).toBe(false);
    // 🔴 AND THE COMPARISON THE ROWS ABOVE USE WOULD HAVE CAUGHT IT.
    expect(() => expect(ssr.allowed).toBe(mint.allowed)).toThrow();
  });
});
