import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    name: 'banned publisher, owner viewer',
    viewer: { id: OWNER },
    ownerBannedAt: new Date('2026-09-01'),
    expectAllowed: false,
  },
  {
    name: 'pending (re-submitted) app',
    viewer: { id: OWNER },
    block: blockRow({ status: 'pending' }),
    expectAllowed: true,
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
      const reachesTheResolve =
        (s.flag ?? true) &&
        s.viewer != null &&
        (s.viewer as { bannedAt?: Date }).bannedAt === undefined;
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

  it('🔴 NEGATIVE CONTROL: the harness CAN observe a disagreement', () => {
    // The assertion `ssr.allowed === mint.allowed` is only a guard if an unequal pair
    // would fail it. Proven directly on the comparison rather than by corrupting the
    // predicate — the point is that the ASSERTION discriminates, and a test that never
    // shows its own comparison failing is a test of nothing.
    const a = { allowed: true as const, audience: 'owner' as const };
    const b = { allowed: false as const, reason: 'no-role' as const };
    expect(() => expect(a.allowed).toBe(b.allowed)).toThrow();
    const c = { allowed: true as const, audience: 'editor' as const };
    expect(() => expect(a.audience).toBe(c.audience)).toThrow();
  });

});
