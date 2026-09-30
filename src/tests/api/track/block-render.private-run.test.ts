import { beforeEach, describe, expect, it, vi } from 'vitest';
import client from 'prom-client';
import type { NextApiRequest, NextApiResponse } from 'next';
import type * as PrivateRunAccessModule from '~/server/services/blocks/private-run-access.service';
import type { SessionUser } from '~/types/session';

/**
 * 🔴 BOTH `blockRenders` WRITERS MUST AGREE ABOUT A PRIVATE RUN — behaviourally, through
 * the REAL gate, with ONE fixture driven through both.
 *
 * ── WHY ONE FILE AND NOT TWO ─────────────────────────────────────────────────
 * The `/api/track/block-render` beacon and the `track.blockRender` tRPC procedure both
 * insert into `blockRenders`. The beacon is what the browser hosts use; the procedure is
 * kept for bearer/API-key callers. A fix applied to one leaves the other able to
 * reintroduce the leak — the same failure shape `blockRenderTrackerPayload` exists to
 * prevent for the payload, one level up. The claim is a RELATIONSHIP, so it is asserted
 * against both writers side by side rather than split across two suites that can drift.
 * The structural half — that the writer SET is exactly these two and that both call the
 * gate — is `blocks/__tests__/block-render-writer.call-site-ledger.test.ts`; neither half
 * is sufficient, because a ledger type-checks past a wrong argument and this file cannot
 * see a third writer nobody told it about.
 *
 * ── THIS FILE USES THE REAL GATE ─────────────────────────────────────────────
 * `isPrivateRunImpression` is NOT mocked here — only its three leaf inputs are (the
 * approved-app cache, the flag accessor, the access predicate). The sibling suites
 * `src/tests/api/track/block-render.test.ts` and
 * `src/server/routers/__tests__/track.router.blockRender.test.ts` DO mock the gate,
 * deliberately, so their subject stays `isAnon`/prom/`secondary`. If the gate were mocked
 * everywhere, a gate wired to nothing would be green everywhere.
 *
 * ── AND IT LIVES UNDER `src/tests/`, WHICH IS TYPECHECKED ────────────────────
 * `tsconfig.json` excludes every `__tests__` directory under `src/` but NOT `src/tests/`.
 * A private-run spoofing test whose own types are wrong would merge green from the
 * excluded directory. (Written without a glob on purpose: a `*` immediately before a `/`
 * closes a block comment, which cost this file one collection failure — "0 tests", not a
 * red assertion.)
 */

const { mockCh, mockSession, mockKnown, mockFlag, mockAccess, devStore, sessionStore } = vi.hoisted(
  () => ({
    mockCh: { insert: vi.fn() },
    mockSession: vi.fn(),
    mockKnown: { boundAppBlockIdLabel: vi.fn(), isConfirmedNonApprovedAppBlockId: vi.fn() },
    mockFlag: { isAppBlocksPrivateRunEnabled: vi.fn() },
    mockAccess: { resolvePrivateRunAccess: vi.fn() },
    devStore: { isDev: false },
    sessionStore: { session: null as { user?: SessionUser } | null },
  })
);

vi.mock('~/server/utils/endpoint-helpers', () => ({
  PublicEndpoint: (handler: unknown) => handler,
}));

// 🔴 `isProd` IS **FALSE**, NOT `!isDev`, AND THAT IS A REAL TRAP RATHER THAN A TIDY-UP.
// The sibling suite spells it `!devStore.isDev`, which with `isDev = false` makes `isProd`
// TRUE — and `src/env/client-schema.ts` reads
// `NEXT_PUBLIC_CIVITAI_LINK: isProd ? z.url() : z.url().optional()`. So any module graph
// this file pulls in that reaches `~/env/client` — which validates UNCONDITIONALLY at
// module scope — throws `Invalid environment variables`, the gate's catch swallows it,
// and the suppression cases read "1 row" with nothing pointing at the env. Under
// `NODE_ENV=test` both flags really are false, so this mock is also the faithful one.
//
// The sibling suite is NOT wrong to keep `!devStore.isDev`: it mocks the gate wholesale,
// so the predicate's graph — and `~/env/client` — is never evaluated there, and some of
// its cases flip `devStore.isDev = true` expecting `isProd` to follow. Left alone
// deliberately, not overlooked.
vi.mock('~/env/other', () => ({
  get isDev() {
    return devStore.isDev;
  },
  isProd: false,
  isTest: true,
  isPreview: false,
}));

vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: (...args: unknown[]) => {
    mockSession(...args);
    return Promise.resolve(sessionStore.session);
  },
}));

// The ClickHouse seam for the BEACON writer. `mockCh.insert` standing in for
// `Tracker.blockRender` is the thing whose call count IS the impression.
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    blockRender = mockCh.insert;
  },
}));

vi.mock('~/server/services/blocks/known-app-blocks.service', () => mockKnown);
vi.mock('~/server/services/app-blocks-flag', () => mockFlag);
// A plain factory rather than `importOriginal`: this file needs only the predicate's TYPE
// (erased at runtime), so evaluating the real module — which statically pulls `dbRead`,
// `dbWrite` and `BlockRegistry` — would buy nothing. The sibling gate suite uses
// `importOriginal` on this same module because it needs the real
// `PRIVATE_RUN_REFUSAL_REASONS` tuple; nothing about the module prevents it here.
vi.mock('~/server/services/blocks/private-run-access.service', () => mockAccess);

// The CANONICAL logging mock — `~/server/logging/client` has one, so a per-file
// registration of it would be a `no-direct-shared-module-mock` failure. Used here as the
// discriminator between "the gate decided" and "the gate fell open".
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { trackRouter } from '~/server/routers/track.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/** A delisted app — the only kind a private run can serve. */
const DELISTED_APP = 'apb_delisted_symmetry';
/** A live, approved app. */
const APPROVED_APP = 'apb_approved_symmetry';

const MODERATOR: SessionUser = { id: 9101, isModerator: true } as SessionUser;
const STRANGER: SessionUser = { id: 9102, isModerator: false } as SessionUser;

const identifiers = () => ({
  appBlockId: DELISTED_APP,
  blockInstanceId: 'page_apb_delisted_symmetry',
  slotId: 'app.page',
});

// ── harnesses ────────────────────────────────────────────────────────────────

function makeRes() {
  const res = {} as NextApiResponse & { _status?: number };
  res.status = vi.fn((code: number) => {
    res._status = code;
    return res;
  }) as unknown as NextApiResponse['status'];
  res.send = vi.fn(() => res) as unknown as NextApiResponse['send'];
  res.end = vi.fn(() => res) as unknown as NextApiResponse['end'];
  return res;
}

function makeReq(body: unknown) {
  return {
    method: 'POST',
    headers: { host: 'civitai.com', origin: 'https://civitai.com' },
    body: JSON.stringify(body),
  } as unknown as NextApiRequest;
}

/** Drive the BEACON writer. Returns the number of `blockRenders` inserts it produced. */
async function viaBeacon(body: unknown): Promise<number> {
  const handler = (await import('~/pages/api/track/block-render')).default;
  const res = makeRes();
  await (handler as (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>)(
    makeReq(body),
    res
  );
  expect(res.status).toHaveBeenCalledWith(200);
  return mockCh.insert.mock.calls.length;
}

// A FRESH ctx per call: the publicProcedure chain's applyDomainFeature middleware mutates
// the raw input object in place, so a shared object leaks between cases.
function fakeCtx(user: SessionUser | undefined) {
  return {
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    // x-client !== 'web' → enforceClientVersion's needsUpdate() short-circuits.
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: { canViewNsfw: false },
    track: { blockRender: mockCh.insert },
  } as unknown as Parameters<typeof trackRouter.createCaller>[0];
}

/** Drive the tRPC writer. Returns the number of `blockRenders` inserts it produced. */
async function viaTrpc(input: unknown, user: SessionUser | undefined): Promise<number> {
  const caller = trackRouter.createCaller(fakeCtx(user));
  await caller.blockRender(input as Parameters<typeof caller.blockRender>[0]);
  return mockCh.insert.mock.calls.length;
}

// ── world setup ──────────────────────────────────────────────────────────────

/**
 * ARM GATE 3.5's COST CEILING TO ALLOW.
 *
 * 🔴 NOT OPTIONAL HOUSEKEEPING — without it every case in this file would pass for the wrong
 * reason. The gate now consults a per-viewer Redis ceiling before the access predicate, and a
 * bare `sysRedis` hybrid node makes `multi()` return `undefined`, so the limiter throws inside
 * its own try and FAILS OPEN. The suppression table would then be measuring a gate whose
 * ceiling is effectively absent, and would stay green if the ceiling were later wired to
 * refuse everything. An explicit always-under-the-window reply makes the pass a decision.
 *
 * The ceiling's own behaviour (the boundary, the key, both fail directions, the refusal
 * counter) belongs to `src/server/utils/__tests__/private-run-impression-rate-limit.test.ts`
 * and `blocks/__tests__/private-run-impression.service.test.ts`; this file's subject is the
 * two writers agreeing, so it holds the ceiling constant rather than exercising it.
 */
function allowRateLimiter() {
  redisMock.sysRedis.ttl.mockResolvedValue(60);
  redisMock.sysRedis.multi.mockImplementation(() => {
    const chain: Record<string, unknown> = {
      set: () => chain,
      incr: () => chain,
      exec: async () => ['OK', 1],
    };
    return chain;
  });
}

/** Non-approved app, flag on — the world in which a private run is possible. */
function armed() {
  allowRateLimiter();
  mockKnown.boundAppBlockIdLabel.mockImplementation(async (id: string) =>
    id === APPROVED_APP ? id : 'other'
  );
  mockKnown.isConfirmedNonApprovedAppBlockId.mockImplementation(
    async (id: string) => id !== APPROVED_APP
  );
  mockFlag.isAppBlocksPrivateRunEnabled.mockResolvedValue(true);
}

function grants() {
  mockAccess.resolvePrivateRunAccess.mockResolvedValue({
    allowed: true,
    audience: 'moderator',
    block: { appBlockId: DELISTED_APP },
  });
}

function refuses(reason: PrivateRunAccessModule.PrivateRunRefusalReason = 'no-role') {
  mockAccess.resolvePrivateRunAccess.mockResolvedValue({ allowed: false, reason });
}

beforeEach(() => {
  vi.clearAllMocks();
  devStore.isDev = false;
  sessionStore.session = null;
  armed();
  refuses();
});

// ── the symmetry table ───────────────────────────────────────────────────────

type Scenario = {
  name: string;
  viewer: SessionUser | undefined;
  appBlockId: string;
  /** Called before the writers run, to set the world. */
  world?: () => void;
  /** 1 = the impression is recorded; 0 = it is suppressed. */
  expectInserts: 0 | 1;
  /**
   * TRUE when this row is supposed to reach the gate's fail-open catch rather than a
   * decision. Exactly one row sets it, and that is what makes `decided()` below a
   * discriminator instead of a constant.
   */
  expectThrow?: true;
};

/**
 * Did the gate DECIDE, or fall open?
 *
 * The two are indistinguishable from the insert count alone — a gate that throws on every
 * call produces exactly the "1 row" that a correct refusal produces — so every recording
 * case would otherwise pass just as happily with the gate broken. The fail-open path is
 * the one that logs, so the log IS the discriminator.
 *
 * 🔴 FILTERED BY EVENT NAME. An unfiltered "did `logToAxiom` fire" is not this question:
 * the beacon route writes its OWN `block-render-unknown-app` line for any id outside the
 * approved set, which is EVERY fixture in this file by construction.
 *
 * ⚠️ IT MEASURES "THE GATE'S OWN `catch` DID NOT FIRE", WHICH IS NARROWER THAN ITS NAME.
 * In production the flag accessor and the approved-set lookup swallow their own failures
 * and answer `false` — real fail-opens that log nothing and that this would score as
 * DECIDED. Sound here only because both are mocks that reject outright.
 */
function gateFailedOpen(): boolean {
  const calls = (
    loggingMock.logToAxiom as unknown as { mock: { calls: Array<[{ name?: string }]> } }
  ).mock.calls;
  return calls.some(([payload]) => payload?.name === 'private-run-impression-gate-failed');
}

function decided(): boolean {
  return !gateFailedOpen();
}

const SCENARIOS: Scenario[] = [
  {
    name: 'a moderator privately running a delisted app',
    viewer: MODERATOR,
    appBlockId: DELISTED_APP,
    world: grants,
    expectInserts: 0,
  },
  {
    name: 'an unrelated viewer of the same delisted app (no-role)',
    viewer: STRANGER,
    appBlockId: DELISTED_APP,
    expectInserts: 1,
  },
  {
    name: 'a signed-out viewer',
    viewer: undefined,
    appBlockId: DELISTED_APP,
    world: grants,
    expectInserts: 1,
  },
  {
    name: 'a moderator on an APPROVED app (the public path owns it)',
    viewer: MODERATOR,
    appBlockId: APPROVED_APP,
    world: grants,
    expectInserts: 1,
  },
  {
    name: 'a moderator with the FLAG OFF',
    viewer: MODERATOR,
    appBlockId: DELISTED_APP,
    world: () => {
      grants();
      mockFlag.isAppBlocksPrivateRunEnabled.mockResolvedValue(false);
    },
    expectInserts: 1,
  },
  {
    name: 'a delisted app whose access resolve THROWS',
    viewer: MODERATOR,
    appBlockId: DELISTED_APP,
    world: () => mockAccess.resolvePrivateRunAccess.mockRejectedValue(new Error('db down')),
    expectInserts: 1,
    expectThrow: true,
  },
];

/**
 * 🔴 THE LABEL IS PER TEST, NOT PER FILE, AND THAT CORRECTION IS THE POINT.
 *
 * This describe was labelled `[REG]` wholesale. Applying this repo's own mechanical
 * definition — would it go RED against pre-change behaviour? — only ONE of its rows
 * qualifies: at base nothing is ever suppressed, so every `expectInserts: 1` row is green
 * there and is an INVARIANT guard. Labelling five invariants as regression coverage is
 * the exact mistake `app-analytics.private-run-exclusion.test.ts` records having made and
 * corrected, so each `it` carries its own label below.
 *
 * ⚠️ AND `[REG]` IS NOT ESTABLISHABLE HERE THE USUAL WAY: `private-run-impression.service`
 * does not exist at `origin/main`, so at base this file is a COLLECTION FAILURE — "no
 * tests" — not a red assertion. The substitute measurement is gate-removal at BOTH
 * writers on this tree, which reproduces base behaviour at both: **10 of 16 red**. That
 * is a real measurement and it is not the claim `[REG]` normally makes; recorded here so
 * it is never quoted as "watched red at the base ref".
 *
 * 🔴 THAT NUMBER MOVES WHEN THIS FILE GAINS ASSERTIONS, so re-run the experiment rather
 * than editing the digit: strip the `isPrivateRunImpression` call from both writers and
 * count. (It read 4 while only the insert counts were asserted; adding the reachability
 * and decided-vs-fail-open assertions took it to 10.)
 */
describe('the two blockRenders writers agree about a private run', () => {
  for (const s of SCENARIOS) {
    const label = s.expectInserts === 0 ? '[REG]' : '[INV]';
    it(`${label} ${s.name} → ${s.expectInserts} row, from BOTH writers`, async () => {
      // BEACON
      vi.clearAllMocks();
      armed();
      refuses();
      s.world?.();
      sessionStore.session = s.viewer ? { user: s.viewer } : null;
      const beacon = await viaBeacon({ ...identifiers(), appBlockId: s.appBlockId });
      const beaconDecided = decided();

      // tRPC
      vi.clearAllMocks();
      armed();
      refuses();
      s.world?.();
      const trpc = await viaTrpc({ ...identifiers(), appBlockId: s.appBlockId }, s.viewer);

      expect(beacon, 'the beacon writer').toBe(s.expectInserts);
      expect(trpc, 'the tRPC writer').toBe(s.expectInserts);
      expect(beacon, 'the two writers must agree').toBe(trpc);

      // 🔴 DECIDED, NOT FELL OPEN. Without this, every `expectInserts: 1` row is ALSO what
      // a gate that throws on every call produces — so the recording half of the table
      // could not tell "the gate answered false" from "the gate is broken", which is the
      // failure this whole design fails toward. `expectThrow` rows assert the inverse, so
      // the pair is a control rather than a blanket.
      expect(beaconDecided, 'beacon: gate decided vs failed open').toBe(!s.expectThrow);
      expect(decided(), 'tRPC: gate decided vs failed open').toBe(!s.expectThrow);
    });
  }

  it('[INV] POSITIVE CONTROL: the table exercises both polarities on both writers', () => {
    // Without both polarities present, "they agree" is satisfied by two writers that
    // always suppress, or two that never do.
    expect(SCENARIOS.filter((s) => s.expectInserts === 0).length).toBeGreaterThan(0);
    expect(SCENARIOS.filter((s) => s.expectInserts === 1).length).toBeGreaterThan(3);
    // And at least one row must exercise the fail-open path, or the `decided()` assertion
    // above is a constant rather than a discriminator.
    expect(SCENARIOS.filter((s) => s.expectThrow).length).toBeGreaterThan(0);
  });
});

describe('🔴 the private-run signal cannot be SPOOFED from the request body', () => {
  // The case a happy-path suite misses. `/api/track/block-render` is a PublicEndpoint and
  // `track.blockRender` is a publicProcedure, so the body is attacker-chosen. If the
  // signal were read from it, any viewer could suppress their own impressions — hiding
  // real traffic from an owner, or corrupting every owner's numbers at scale. That is a
  // larger defect than the leak this change closes.
  const SPOOFS: Record<string, unknown>[] = [
    { privateRun: true },
    { isPrivateRun: true },
    { source: 'private-run' },
    { audience: 'moderator' },
    { privateRun: true, source: 'private-run', isAnon: true, userId: 1 },
  ];

  for (const spoof of SPOOFS) {
    it(`records the impression despite ${JSON.stringify(spoof)} in the body`, async () => {
      // An unrelated viewer of a NON-APPROVED app: every gate before the predicate PASSES,
      // so the request reaches the one check that can refuse it.
      refuses('no-role');
      sessionStore.session = { user: STRANGER };

      expect(await viaBeacon({ ...identifiers(), ...spoof })).toBe(1);
      // "1 row" is also what an earlier short-circuit, a broken leaf mock, or a gate that
      // threw would produce — so reachability is asserted here, not claimed above.
      expect(
        mockAccess.resolvePrivateRunAccess,
        'the spoof must REACH the predicate'
      ).toHaveBeenCalled();
      expect(decided(), 'and the predicate must have DECIDED, not fallen open').toBe(true);
      // And nothing smuggled reaches the row.
      expect(Object.keys(mockCh.insert.mock.calls[0][0]).sort()).toEqual([
        'appBlockId',
        'blockInstanceId',
        'isAnon',
        'slotId',
      ]);

      vi.clearAllMocks();
      armed();
      refuses('no-role');
      expect(await viaTrpc({ ...identifiers(), ...spoof }, STRANGER)).toBe(1);
      expect(
        mockAccess.resolvePrivateRunAccess,
        'tRPC: the spoof must REACH the predicate'
      ).toHaveBeenCalled();
      expect(decided(), 'tRPC: decided, not fallen open').toBe(true);
    });
  }

  it('🔴 and the SERVER WINS IN BOTH DIRECTIONS — a body claiming NOT-private is still suppressed', async () => {
    // The mirror image, and the half that proves the body is ignored rather than merely
    // insufficient: a real private run that denies it in the payload is still suppressed.
    grants();
    sessionStore.session = { user: MODERATOR };
    expect(await viaBeacon({ ...identifiers(), privateRun: false, source: 'app-block' })).toBe(0);

    vi.clearAllMocks();
    armed();
    grants();
    expect(
      await viaTrpc({ ...identifiers(), privateRun: false, source: 'app-block' }, MODERATOR)
    ).toBe(0);
  });

  it('derives the viewer from the RESOLVED SESSION, not from the body', async () => {
    // The beacon route must hand the gate the session it resolved. A body-derived viewer
    // would let a caller nominate someone else's identity.
    grants();
    sessionStore.session = { user: MODERATOR };
    await viaBeacon({ ...identifiers(), userId: STRANGER.id });

    expect(mockAccess.resolvePrivateRunAccess).toHaveBeenCalledWith(
      expect.objectContaining({ viewer: MODERATOR, by: { appBlockId: DELISTED_APP } })
    );
  });
});

describe('a suppressed private run stays VISIBLE internally', () => {
  /**
   * Total across every label set of the render counter.
   *
   * ⚠️ SUMMED RATHER THAN LOOKED UP BY LABEL, and the first version of this DID look one
   * up — on `{app_block_id:'other', slot_id:'app.page'}`, which never exists, because
   * `normalizeSlotId` clamps an id outside the enumerated slot set to `'other'` too. It
   * read `0 → 0` and reported the counter as not incrementing, i.e. a false negative
   * about the production code arrived at through a wrong label guess. The total cannot be
   * wrong about a label, and the delta is the claim.
   *
   * ⚠️ AND `get()` IS ASYNC. Reading it without `await` yields a Promise whose `.values`
   * is `undefined`, which reduces to a confident 0 — the same false negative a second
   * time, from a different cause. Both were caught by the POSITIVE CONTROL below rather
   * than by inspection; that is what the control is for.
   */
  async function rendersTotal(): Promise<number> {
    const metric = client.register.getSingleMetric('civitai_app_block_renders_total');
    if (!metric) return 0;
    const data = await (metric as { get(): Promise<{ values: Array<{ value: number }> }> }).get();
    return data.values.reduce((sum, v) => sum + v.value, 0);
  }

  it('still increments the render counter, while writing NO impression row', async () => {
    // Suppressing the OWNER-VISIBLE rail is the decision; blinding ourselves is not. The
    // prom counter is internal and clamps a non-approved app's id to 'other', so it leaks
    // nothing per-app while remaining the only signal that a review session's host
    // mounted.
    const before = await rendersTotal();

    grants();
    sessionStore.session = { user: MODERATOR };
    expect(await viaBeacon(identifiers())).toBe(0);

    expect(await rendersTotal(), 'the internal render counter must still see the mount').toBe(
      before + 1
    );
  });

  it('POSITIVE CONTROL: the same counter moves for an impression that IS recorded', async () => {
    // Proves the reader above can observe a change at all — without it, `before + 1`
    // could be measuring an accident of registration order rather than this beacon.
    const before = await rendersTotal();
    refuses('no-role');
    sessionStore.session = { user: STRANGER };
    expect(await viaBeacon(identifiers())).toBe(1);
    expect(await rendersTotal()).toBe(before + 1);
  });
});
