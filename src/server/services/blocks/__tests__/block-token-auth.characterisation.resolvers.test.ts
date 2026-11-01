import { beforeEach, describe, expect, it, vi } from 'vitest';
// Setup-order import: installs the shared db/redis/env/prom mocks (and the test RSA keypair)
// before any module under test evaluates.
import '~/__tests__/setup';
import type * as BlockScopeMiddleware from '~/server/middleware/block-scope.middleware';
import type * as AppBlocksFlag from '~/server/services/app-blocks-flag';
import type * as RuntimeMetrics from '~/server/metrics/app-block-runtime.metrics';
import type * as ConsentRevocationModule from '~/server/services/blocks/consent-revocation.service';
import type * as DevTunnelModule from '~/server/services/blocks/dev-tunnel.service';
import type * as WriteTrustModule from '~/server/services/blocks/block-write-trust.service';

/**
 * CHARACTERISATION — the three tRPC block-token RESOLVERS, side by side, today.
 *
 *   - `authorizeBlockBridgeToken`  (`blocks/block-bridge-auth.service.ts`)  — the bridge
 *   - `resolveSharedContext`       (`routers/apps-shared.router.ts`)        — shared storage
 *   - `resolveStorageContext`      (`apps/app-storage.service.ts`)          — per-user storage
 *     (module-private; driven through `getAppStorageValue` / `setAppStorageValue`, the only
 *     doors to it — both transports call exactly these)
 *
 * plus `assertAppBlocksEnabledForTokenUser`, the subject-hydration + run-flag gate most bridge
 * procedures call after the bridge resolver (the bridge resolver itself hydrates nothing).
 *
 * ## What this file is FOR
 *
 * These resolvers are slated to be consolidated into ONE. The consolidation is meant to change
 * NOTHING. This file pins, as literal tables, what each resolver does today for every failure
 * mode we could drive, so the consolidating change either leaves every cell green or names the
 * cells it moved. It is not a statement that today's behaviour is right — several cells differ
 * between resolvers ON PURPOSE, and the comments that say so are quoted below.
 *
 * Every expectation is a literal. Nothing is derived from the code under test, and nothing is a
 * snapshot file: a cell that moves must be edited here, by hand, in the same change.
 *
 * ## The deliberate differences, quoted from the source (do not "align" them by accident)
 *
 * `block-bridge-auth.service.ts`:
 *   > 🔴 ONE REMAINING ASYMMETRY, AND IT IS DELIBERATE: a MISSING row. This path answers
 *   > `NOT_FOUND`; the REST wrapper counts it and SERVES the request […] Do not "fix" that
 *   > difference without deciding it.
 *   > […] What they do about the answer is deliberately different, and this is the divergence
 *   > to keep in mind before "aligning" them […] If you make these agree, make it a decision,
 *   > not a refactor.
 *
 * `apps-shared.router.ts` (`resolveSharedContext`):
 *   > 🔴 THE STRICTEST OF THE THREE RESOLVERS THAT READ THIS ROW, AND DELIBERATELY SO. […]
 *   > This one exempts NOTHING, because shared storage is cross-user, app-global state and the
 *   > review mint never grants `apps:storage:shared:*` at all […] Do not "align" these three
 *   > without deciding it
 *
 * `app-storage.service.ts` (`resolveStorageContext`):
 *   > 🔴 STRICTER THAN THE SHARED PREDICATE, AND THAT IS A STATEMENT ABOUT THIS TARGET RATHER
 *   > THAN ABOUT APPROVAL. The run-for-real branch above is this resolver's ONLY exemption. […]
 *   > Three rules, one policy plus two structural narrowings
 *
 * ## The ORDER difference, pinned by the `revoked + not approved` rows
 *
 * The bridge and per-user storage check revocation BEFORE the approval row; shared storage
 * reads the approval row FIRST and only then checks revocation. So for an instance that is
 * both revoked and not approved, bridge/storage answer `block instance revoked` and shared
 * answers `app block is not approved`. The `reads` field on every cell records every revocation,
 * approval-row and publish-request read each path made, with its arguments, which pins the
 * order — and the keys — on every row,
 * not only on the two that make it visible in the message.
 *
 * ## Mock seams
 *
 * The narrowest ones the existing suites use: `verifyBlockToken` (the rest of
 * `block-scope.middleware` — in particular `parseSubjectUserId` — stays REAL),
 * `BlockRevocation.isRevoked`, `ConsentRevocation.lookup` (its pure helpers stay real), the
 * shared Prisma mock, `getActiveDevTunnel`, `sessionClient.getSessionUserById`, the flag
 * evaluators, `hasLinkedOAuthAccount` (the trust predicate itself stays real), the apps-db pool
 * and the review-preview provisioner. The metric emitters are spied, not replaced in kind.
 *
 * The garbage-token row runs the REAL `verifyBlockToken` against a non-JWT string.
 */

const h = vi.hoisted(() => ({
  verify: vi.fn(),
  realVerify: { fn: null as null | ((t: string) => Promise<unknown>) },
  isRevoked: vi.fn(),
  consentLookup: vi.fn(),
  getActiveDevTunnel: vi.fn(),
  getSessionUserById: vi.fn(),
  isAppBlocksEnabled: vi.fn(),
  isAppBlocksAuthorEnabled: vi.fn(),
  isAppBlocksSharedStorageEnabled: vi.fn(),
  hasLinkedOAuthAccount: vi.fn(),
  poolQuery: vi.fn(),
  provisionReviewPreview: vi.fn(),
  recordBlockRevocationRefusal: vi.fn(),
  recordBlockConsentMarkerUnavailable: vi.fn(),
  recordConsentStrip: vi.fn(),
}));

vi.mock('~/server/middleware/block-scope.middleware', async (importOriginal) => {
  const real = await importOriginal<typeof BlockScopeMiddleware>();
  h.realVerify.fn = real.verifyBlockToken as (t: string) => Promise<unknown>;
  return { ...real, verifyBlockToken: (t: string) => h.verify(t) };
});
vi.mock('~/server/services/block-revocation.service', () => ({
  BlockRevocation: { isRevoked: (...a: unknown[]) => h.isRevoked(...a) },
}));
vi.mock('~/server/services/blocks/consent-revocation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ConsentRevocationModule>()),
  ConsentRevocation: { lookup: (...a: unknown[]) => h.consentLookup(...a) },
}));
vi.mock('~/server/services/blocks/dev-tunnel.service', async (importOriginal) => ({
  ...(await importOriginal<typeof DevTunnelModule>()),
  getActiveDevTunnel: (...a: unknown[]) => h.getActiveDevTunnel(...a),
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: (...a: unknown[]) => h.getSessionUserById(...a) },
}));
vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof AppBlocksFlag>()),
  isAppBlocksEnabled: (...a: unknown[]) => h.isAppBlocksEnabled(...a),
  isAppBlocksAuthorEnabled: (...a: unknown[]) => h.isAppBlocksAuthorEnabled(...a),
  isAppBlocksSharedStorageEnabled: (...a: unknown[]) => h.isAppBlocksSharedStorageEnabled(...a),
}));
vi.mock('~/server/services/blocks/block-write-trust.service', async (importOriginal) => ({
  ...(await importOriginal<typeof WriteTrustModule>()),
  hasLinkedOAuthAccount: (...a: unknown[]) => h.hasLinkedOAuthAccount(...a),
}));
vi.mock('~/server/db/appsDb', () => ({
  requireAppsDb: () => ({ query: (...a: unknown[]) => h.poolQuery(...a) }),
}));
vi.mock('~/server/services/apps/storage-provision.service', () => ({
  AppStorageProvisioner: {
    provisionReviewPreview: (...a: unknown[]) => h.provisionReviewPreview(...a),
  },
}));
vi.mock('~/server/metrics/app-block-runtime.metrics', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeMetrics>()),
  recordBlockRevocationRefusal: (...a: unknown[]) => h.recordBlockRevocationRefusal(...a),
  recordBlockConsentMarkerUnavailable: (...a: unknown[]) =>
    h.recordBlockConsentMarkerUnavailable(...a),
  recordConsentStrip: (...a: unknown[]) => h.recordConsentStrip(...a),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { appStorageOpsCounter } from '~/server/prom/client';
import { authorizeBlockBridgeToken } from '~/server/services/blocks/block-bridge-auth.service';
import { resolveSharedContext } from '~/server/routers/apps-shared.router';
import { getAppStorageValue, setAppStorageValue } from '~/server/services/apps/app-storage.service';
import { assertAppBlocksEnabledForTokenUser } from '~/server/services/blocks/block-token-access.service';
import { OnboardingSteps } from '~/server/common/enums';

// ── fixture world ────────────────────────────────────────────────────────────────────────

const SUBJECT_ID = 42;
const OWNER_ID = 42;
const ALL_SCOPES = [
  'apps:storage:read',
  'apps:storage:write',
  'apps:storage:shared:read',
  'apps:storage:shared:write',
  'buzz:read:self',
  'posts:write:self',
  'models:read:self',
];

function claims(over: Record<string, unknown> = {}) {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: `user:${SUBJECT_ID}`,
    iat: 0,
    exp: 0,
    jti: 'jti_char',
    blockId: 'char-block',
    appId: 'app_char',
    appBlockId: 'apb_claim',
    blockInstanceId: 'bki_char',
    ctx: {},
    scopes: [...ALL_SCOPES],
    ...over,
  };
}

/** A subject that passes the REAL shared-write trust predicate. */
const TRUSTED_SUBJECT = {
  id: SUBJECT_ID,
  username: 'char',
  isModerator: false,
  tier: 'free',
  onboarding: OnboardingSteps.Buzz | OnboardingSteps.TOS,
  emailVerified: new Date('2020-01-01T00:00:00Z'),
  createdAt: new Date('2020-01-01T00:00:00Z'),
  bannedAt: null,
  muted: false,
};

type World = {
  claims: Record<string, unknown> | 'REAL_VERIFY';
  token: string;
  revoked: boolean;
  row: { id: string; status: string } | null | 'THROWS';
  owner: number | null;
  tunnel: 'live' | 'none' | 'THROWS';
  consent: { kind: 'none' } | { kind: 'revoked'; scopes: string[] } | { kind: 'unavailable' };
  subject: typeof TRUSTED_SUBJECT | null;
  runFlag: boolean;
  authorFlag: boolean;
  sharedFlag: boolean;
  /**
   * What a flag evaluation WITHOUT a user answers (a global eval — the flag's base value). The
   * three flags above apply ONLY to the token subject's own user id, so an evaluation handed
   * the wrong user, or no user, gets this instead. Default off, as the flags ship today.
   */
  flagBase: boolean;
  publishRequest: { status: string } | null;
};

function baseWorld(): World {
  return {
    claims: claims(),
    token: 'tok',
    revoked: false,
    row: { id: 'apb_row', status: 'approved' },
    owner: OWNER_ID,
    tunnel: 'none',
    consent: { kind: 'none' },
    subject: { ...TRUSTED_SUBJECT },
    runFlag: true,
    authorFlag: true,
    sharedFlag: true,
    flagBase: false,
    publishRequest: { status: 'pending' },
  };
}

function install(w: World) {
  h.verify.mockImplementation(async (t: string) =>
    w.claims === 'REAL_VERIFY' ? h.realVerify.fn!(t) : w.claims
  );
  h.isRevoked.mockImplementation(async () => w.revoked);
  dbMock.dbRead.appBlock.findUnique.mockImplementation(async () => {
    if (w.row === 'THROWS') throw new Error('replica unreachable');
    return w.row;
  });
  dbMock.dbRead.oauthClient.findUnique.mockImplementation(async () =>
    w.owner == null ? null : { userId: w.owner }
  );
  dbMock.dbWrite.appBlockPublishRequest.findUnique.mockImplementation(async () => w.publishRequest);
  h.getActiveDevTunnel.mockImplementation(async () => {
    if (w.tunnel === 'THROWS') throw new Error('sysredis down');
    return w.tunnel === 'live' ? { sessionId: 's', userId: OWNER_ID, blockId: 'char-block' } : null;
  });
  h.consentLookup.mockImplementation(async () =>
    w.consent.kind === 'revoked'
      ? { kind: 'revoked', scopes: new Set(w.consent.scopes) }
      : w.consent
  );
  // Answers ONLY for the id actually asked for: the token subject's row (or `null` when the
  // world says it will not hydrate); any other id is an unknown user.
  h.getSessionUserById.mockImplementation(async (id: number) =>
    id === SUBJECT_ID ? w.subject : null
  );
  // Keyed on WHO the flag is evaluated for: on only for the token subject, base value otherwise.
  const forSubject = (on: boolean) => async (opts?: { user?: { id?: number } }) =>
    opts?.user ? opts.user.id === SUBJECT_ID && on : w.flagBase;
  h.isAppBlocksEnabled.mockImplementation(forSubject(w.runFlag));
  h.isAppBlocksAuthorEnabled.mockImplementation(forSubject(w.authorFlag));
  h.isAppBlocksSharedStorageEnabled.mockImplementation(forSubject(w.sharedFlag));
  h.hasLinkedOAuthAccount.mockImplementation(async () => false);
  h.poolQuery.mockImplementation(async () => ({ rows: [{ value: 'stored-value' }] }));
  h.provisionReviewPreview.mockImplementation(async () => ({ schema: '"apprev_pubreq_char"' }));
}

// ── observation ──────────────────────────────────────────────────────────────────────────

type Thrown = { error: string; code?: string; message: string };
type Cell = {
  /** What the call produced: `ok` (the success shape) or the error it threw. */
  result: { ok: unknown } | Thrown;
  /**
   * Every revocation read (its ARGUMENTS: instance id, subject), every approval-row read (its
   * `where`) and every publish-request read (its `where`), in call order. The arguments are
   * the point: a revocation read that drops the subject disables the subject-scoped ban leg,
   * and a row read keyed on the wrong id reads a different row, with no change in any message.
   */
  reads: { revocation: unknown[][]; row: unknown[]; publishRequest: unknown[]; hydrate: unknown[] };
  /** Metric emissions the path made (spied emitters / the storage ops counter). */
  metrics: string[];
};

function describeError(err: unknown): Thrown {
  const e = err as { constructor?: { name?: string }; code?: unknown; message?: unknown };
  const name = e?.constructor?.name ?? typeof err;
  return {
    error: name,
    ...(typeof e?.code === 'string' && name === 'TRPCError' ? { code: e.code } : {}),
    message: String(e?.message),
  };
}

function metricsEmitted(): string[] {
  const out: string[] = [];
  for (const c of h.recordBlockRevocationRefusal.mock.calls) out.push(`revocation_refusal:${c[0]}`);
  for (const c of h.recordBlockConsentMarkerUnavailable.mock.calls)
    out.push(`consent_marker_unavailable:${c[0]}`);
  for (const c of h.recordConsentStrip.mock.calls)
    out.push(`consent_strip:${c[0]}:${[...(c[2] as Set<string>)].sort().join(',')}`);
  for (const c of vi.mocked(appStorageOpsCounter.inc).mock.calls) {
    const l = c[0] as { op: string; outcome: string };
    out.push(`storage_ops:${l.op}:${l.outcome}`);
  }
  return out;
}

async function observe(run: () => Promise<unknown>): Promise<Cell> {
  let result: Cell['result'];
  try {
    result = { ok: await run() };
  } catch (err) {
    result = describeError(err);
  }
  return {
    result,
    reads: {
      revocation: h.isRevoked.mock.calls.map((c) => [...c]),
      row: dbMock.dbRead.appBlock.findUnique.mock.calls.map(
        (c) => (c[0] as { where: unknown }).where
      ),
      publishRequest: dbMock.dbWrite.appBlockPublishRequest.findUnique.mock.calls.map(
        (c) => (c[0] as { where: unknown }).where
      ),
      // Every session-hydration call, by the user id asked for.
      hydrate: h.getSessionUserById.mock.calls.map((c) => c[0]),
    },
    metrics: metricsEmitted(),
  };
}

type Op = 'read' | 'write';

/** The bridge resolver's success shape: the scopes it hands every bridge proc. */
async function runBridge(token: string) {
  const out = await authorizeBlockBridgeToken(token);
  return { scopes: out.scopes, buzzBudget: out.buzzBudget ?? null };
}

async function runShared(token: string, op: Op) {
  const ctx = await resolveSharedContext(token, op === 'read' ? 'get' : 'append');
  return { ...ctx, subjectUser: ctx.subjectUser ? { id: ctx.subjectUser.id } : null };
}

/**
 * `resolveStorageContext` is module-private, so its success shape is observed through what
 * `getAppStorageValue` does with it: the schema it reads and the (instance, user, key) tuple it
 * binds. A write is only ever expected to FAIL in this table (every write row is a refusal), so
 * `setAppStorageValue` never reaches its DB body here.
 */
async function runStorage(token: string, op: Op) {
  if (op === 'read') {
    const value = await getAppStorageValue(token, 'k');
    const q = h.poolQuery.mock.calls[0] as [string, unknown[]] | undefined;
    return {
      value,
      query: q ? { schema: /FROM (\S+)\.kv/.exec(q[0])?.[1] ?? null, params: q[1] } : null,
    };
  }
  // A write that gets PAST the resolver reaches the pool; say so, rather than letting the
  // mocked pool's answer leak into the cell.
  h.poolQuery.mockImplementation(async () => {
    throw new Error('PAST_RESOLVER: reached the apps-db pool');
  });
  return setAppStorageValue(token, 'k', 'v');
}

function resetObservations() {
  h.isRevoked.mockClear();
  dbMock.dbRead.appBlock.findUnique.mockClear();
  dbMock.dbWrite.appBlockPublishRequest.findUnique.mockClear();
  h.getSessionUserById.mockClear();
  h.poolQuery.mockClear();
  h.recordBlockRevocationRefusal.mockClear();
  h.recordBlockConsentMarkerUnavailable.mockClear();
  h.recordConsentStrip.mockClear();
  vi.mocked(appStorageOpsCounter.inc).mockClear();
}

// ── the scenarios ────────────────────────────────────────────────────────────────────────

type Scenario = { name: string; op: Op; world: (w: World) => void };

const SCENARIOS: Scenario[] = [
  { name: 'success — read', op: 'read', world: () => undefined },
  {
    name: 'garbage token (real verifier)',
    op: 'read',
    world: (w) => {
      w.claims = 'REAL_VERIFY';
      w.token = 'not-a-jwt';
    },
  },
  {
    name: 'blockId that is not a valid storage slug',
    op: 'read',
    world: (w) => {
      w.claims = claims({ blockId: '9!' });
    },
  },
  { name: 'revoked instance', op: 'read', world: (w) => void (w.revoked = true) },
  { name: 'no approval row (non-dev token)', op: 'read', world: (w) => void (w.row = null) },
  {
    name: 'row not approved (non-dev token)',
    op: 'read',
    world: (w) => void (w.row = { id: 'apb_row', status: 'suspended' }),
  },
  {
    name: 'revoked AND row not approved — which wins',
    op: 'read',
    world: (w) => {
      w.revoked = true;
      w.row = { id: 'apb_row', status: 'suspended' };
    },
  },
  {
    name: 'revoked AND no approval row — which wins',
    op: 'read',
    world: (w) => {
      w.revoked = true;
      w.row = null;
    },
  },
  {
    name: 'approval-row read throws',
    op: 'read',
    world: (w) => void (w.row = 'THROWS'),
  },
  {
    name: 'dev token, no approval row',
    op: 'read',
    world: (w) => {
      w.claims = claims({ dev: true });
      w.row = null;
    },
  },
  {
    name: 'dev token, owner, LIVE dev tunnel, row not approved',
    op: 'read',
    world: (w) => {
      w.claims = claims({ dev: true });
      w.row = { id: 'apb_row', status: 'suspended' };
      w.tunnel = 'live';
    },
  },
  {
    name: 'dev token, owner, NO dev tunnel, row not approved',
    op: 'read',
    world: (w) => {
      w.claims = claims({ dev: true });
      w.row = { id: 'apb_row', status: 'suspended' };
    },
  },
  {
    name: 'dev token, NOT the owner, live tunnel, row not approved',
    op: 'read',
    world: (w) => {
      w.claims = claims({ dev: true });
      w.row = { id: 'apb_row', status: 'suspended' };
      w.owner = 99;
      w.tunnel = 'live';
    },
  },
  {
    name: 'dev token, owner, dev-tunnel lookup throws, row not approved',
    op: 'read',
    world: (w) => {
      w.claims = claims({ dev: true });
      w.row = { id: 'apb_row', status: 'suspended' };
      w.tunnel = 'THROWS';
    },
  },
  {
    name: 'review token (dev, synthetic pending appId, no row)',
    op: 'read',
    world: (w) => {
      w.claims = claims({ dev: true, appId: 'pending-01CHAR', appBlockId: 'pubreq_01CHAR' });
      w.row = null;
    },
  },
  {
    name: 'review run-for-real token (dev + reviewRunForReal), request pending',
    op: 'read',
    world: (w) => {
      w.claims = claims({
        dev: true,
        reviewRunForReal: true,
        appId: 'pending-01CHAR',
        appBlockId: 'pubreq_01CHAR',
      });
      w.row = null;
    },
  },
  {
    name: 'review run-for-real token, request no longer pending',
    op: 'read',
    world: (w) => {
      w.claims = claims({
        dev: true,
        reviewRunForReal: true,
        appId: 'pending-01CHAR',
        appBlockId: 'pubreq_01CHAR',
      });
      w.row = null;
      w.publishRequest = { status: 'approved' };
    },
  },
  {
    name: 'review run-for-real token, author flag off',
    op: 'read',
    world: (w) => {
      w.claims = claims({
        dev: true,
        reviewRunForReal: true,
        appId: 'pending-01CHAR',
        appBlockId: 'pubreq_01CHAR',
      });
      w.row = null;
      w.authorFlag = false;
    },
  },
  {
    name: 'reviewRunForReal WITHOUT dev, row not approved',
    op: 'read',
    world: (w) => {
      w.claims = claims({ reviewRunForReal: true });
      w.row = { id: 'apb_row', status: 'suspended' };
    },
  },
  {
    name: 'private-run token (owner audience), row not approved',
    op: 'read',
    world: (w) => {
      w.claims = claims({ privateRun: true, privateRunAudience: 'owner' });
      w.row = { id: 'apb_row', status: 'suspended' };
    },
  },
  {
    name: 'private-run claim with NO audience, row not approved',
    op: 'read',
    world: (w) => {
      w.claims = claims({ privateRun: true });
      w.row = { id: 'apb_row', status: 'suspended' };
    },
  },
  {
    name: 'missing scope — read (token carries no scopes)',
    op: 'read',
    world: (w) => void (w.claims = claims({ scopes: [] })),
  },
  {
    name: 'missing scope — write (token carries only the read scopes)',
    op: 'write',
    world: (w) =>
      void (w.claims = claims({
        scopes: ['apps:storage:read', 'apps:storage:shared:read', 'buzz:read:self'],
      })),
  },
  {
    name: 'consent revoked for posts:write:self + buzz:read:self',
    op: 'read',
    world: (w) =>
      void (w.consent = { kind: 'revoked', scopes: ['posts:write:self', 'buzz:read:self'] }),
  },
  {
    name: 'consent marker unreadable',
    op: 'read',
    world: (w) => void (w.consent = { kind: 'unavailable' }),
  },
  {
    name: 'anonymous subject — read',
    op: 'read',
    world: (w) => void (w.claims = claims({ sub: 'anon' })),
  },
  {
    name: 'anonymous subject — read, flags base-enabled (the GA shape)',
    op: 'read',
    world: (w) => {
      w.claims = claims({ sub: 'anon' });
      w.flagBase = true;
    },
  },
  {
    // Base-enabled so the shared flag (evaluated with no user for an anon subject) admits it
    // and the WRITE refusal itself is what this row pins.
    name: 'anonymous subject — write, flags base-enabled',
    op: 'write',
    world: (w) => {
      w.claims = claims({ sub: 'anon' });
      w.flagBase = true;
    },
  },
  {
    name: 'subject that will not hydrate',
    op: 'read',
    world: (w) => void (w.subject = null),
  },
  {
    name: 'malformed sub (only reachable past a mocked verifier)',
    op: 'read',
    world: (w) => void (w.claims = claims({ sub: 'user:abc' })),
  },
  {
    name: 'flag off (run flag / shared-storage flag)',
    op: 'read',
    world: (w) => {
      w.runFlag = false;
      w.sharedFlag = false;
    },
  },
  {
    name: 'shared write by an untrusted (new) account',
    op: 'write',
    world: (w) =>
      void (w.subject = { ...TRUSTED_SUBJECT, createdAt: new Date(Date.now() - 60_000) }),
  },
];

async function cellsFor(s: Scenario): Promise<{ bridge: Cell; shared: Cell; storage: Cell }> {
  const run = async (fn: (token: string) => Promise<unknown>) => {
    const w = baseWorld();
    s.world(w);
    install(w);
    resetObservations();
    return observe(() => fn(w.token));
  };
  return {
    bridge: await run((t) => runBridge(t)),
    shared: await run((t) => runShared(t, s.op)),
    storage: await run((t) => runStorage(t, s.op)),
  };
}

const T = (code: string, message: string): Thrown => ({ error: 'TRPCError', code, message });
/** The revocation read every path makes for the default token: (instance id, subject) — verbatim. */
const REV = ['bki_char', 'user:42'];
/** The approval-row read every path makes for the default token: the `(appId, blockId)` unique. */
const ROW = { appId_blockId: { appId: 'app_char', blockId: 'char-block' } };

/**
 * THE TABLE. One row per failure mode, one cell per resolver. Each cell is the call's result
 * (success shape or the error it threw — class, tRPC code, message), every read it made WITH
 * ITS ARGUMENTS (`REV` / `ROW` are the default token's revocation and approval-row reads), and
 * the metrics it emitted.
 *
 * Reading guide for the cells most likely to be "aligned" by accident:
 *   - `revoked AND …` rows: bridge/storage say `revoked`, shared says the approval answer —
 *     and shared's empty `revocation` list shows it never reached the revocation read.
 *   - `dev token, no approval row` / `review token`: the bridge ADMITS, shared and storage
 *     answer NOT_FOUND.
 *   - `reviewRunForReal WITHOUT dev`: the bridge's shared predicate requires the `dev` pair and
 *     refuses; storage's own run-for-real branch keys on `reviewRunForReal` alone and admits.
 *   - `private-run`: admitted by the bridge only.
 *   - `missing scope`: the bridge resolver checks no scope at all (each bridge PROC does —
 *     see the procedure table); shared and storage refuse with different message templates.
 *   - `consent …`: only the bridge consults the consent marker.
 *   - `subject that will not hydrate`: shared FORBIDDEN vs storage UNAUTHORIZED, different
 *     messages; the bridge resolver hydrates nothing (its procs do, via
 *     `assertAppBlocksEnabledForTokenUser`, pinned at the foot of this file).
 *   - `malformed sub`: the bridge throws the middleware's PLAIN `ForbiddenError` before the
 *     revocation read; storage throws the same plain error after its scope check; shared
 *     converts it to a TRPCError. A plain error surfaces from tRPC as INTERNAL_SERVER_ERROR.
 *   - `approval-row read throws`: all three propagate the raw error (the REST wrapper is the
 *     one that converts it — see the REST table).
 */
const EXPECTED: Record<string, { bridge: Cell; shared: Cell; storage: Cell }> = {
  'success — read': {
    bridge: {
      result: { ok: { scopes: ALL_SCOPES, buzzBudget: null } },
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    shared: {
      result: {
        ok: {
          userId: 42,
          subjectUser: { id: 42 },
          slug: 'char_block',
          schema: '"app_char_block"',
          appBlockId: 'apb_row',
          blockInstanceId: 'bki_char',
        },
      },
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [42] },
      metrics: [],
    },
    storage: {
      result: {
        ok: {
          value: { value: 'stored-value' },
          query: { schema: '"app_char_block"', params: ['bki_char', 42, 'k'] },
        },
      },
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [42] },
      metrics: ['storage_ops:get:ok'],
    },
  },
  'garbage token (real verifier)': {
    bridge: {
      result: T('UNAUTHORIZED', 'invalid block token'),
      reads: { revocation: [], row: [], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    shared: {
      result: T('UNAUTHORIZED', 'invalid block token'),
      reads: { revocation: [], row: [], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    storage: {
      result: T('UNAUTHORIZED', 'invalid block token'),
      reads: { revocation: [], row: [], publishRequest: [], hydrate: [] },
      metrics: ['storage_ops:get:unauthorized'],
    },
  },
  'blockId that is not a valid storage slug': {
    bridge: {
      result: { ok: { scopes: ALL_SCOPES, buzzBudget: null } },
      reads: {
        revocation: [REV],
        row: [{ appId_blockId: { appId: 'app_char', blockId: '9!' } }],
        publishRequest: [],
        hydrate: [],
      },
      metrics: [],
    },
    shared: {
      result: T('INTERNAL_SERVER_ERROR', 'block id is not a valid storage slug'),
      reads: { revocation: [], row: [], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    storage: {
      result: T('INTERNAL_SERVER_ERROR', 'block id is not a valid storage slug'),
      reads: { revocation: [], row: [], publishRequest: [], hydrate: [] },
      metrics: ['storage_ops:get:error'],
    },
  },
  'revoked instance': {
    bridge: {
      result: T('FORBIDDEN', 'block instance revoked'),
      reads: { revocation: [REV], row: [], publishRequest: [], hydrate: [] },
      metrics: ['revocation_refusal:bridge'],
    },
    shared: {
      result: T('FORBIDDEN', 'block instance revoked'),
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    storage: {
      result: T('FORBIDDEN', 'block instance revoked'),
      reads: { revocation: [REV], row: [], publishRequest: [], hydrate: [] },
      metrics: ['storage_ops:get:unauthorized'],
    },
  },
  'no approval row (non-dev token)': {
    bridge: {
      result: T('NOT_FOUND', 'app block not found'),
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    shared: {
      result: T('NOT_FOUND', 'app block not found'),
      reads: { revocation: [], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    storage: {
      result: T('NOT_FOUND', 'app block not found'),
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: ['storage_ops:get:not_found'],
    },
  },
  'row not approved (non-dev token)': {
    bridge: {
      result: T('FORBIDDEN', 'app block is not approved'),
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    shared: {
      result: T('FORBIDDEN', 'app block is not approved'),
      reads: { revocation: [], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    storage: {
      result: T('FORBIDDEN', 'app block is not approved'),
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: ['storage_ops:get:unauthorized'],
    },
  },
  'revoked AND row not approved — which wins': {
    bridge: {
      result: T('FORBIDDEN', 'block instance revoked'),
      reads: { revocation: [REV], row: [], publishRequest: [], hydrate: [] },
      metrics: ['revocation_refusal:bridge'],
    },
    shared: {
      result: T('FORBIDDEN', 'app block is not approved'),
      reads: { revocation: [], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    storage: {
      result: T('FORBIDDEN', 'block instance revoked'),
      reads: { revocation: [REV], row: [], publishRequest: [], hydrate: [] },
      metrics: ['storage_ops:get:unauthorized'],
    },
  },
  'revoked AND no approval row — which wins': {
    bridge: {
      result: T('FORBIDDEN', 'block instance revoked'),
      reads: { revocation: [REV], row: [], publishRequest: [], hydrate: [] },
      metrics: ['revocation_refusal:bridge'],
    },
    shared: {
      result: T('NOT_FOUND', 'app block not found'),
      reads: { revocation: [], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    storage: {
      result: T('FORBIDDEN', 'block instance revoked'),
      reads: { revocation: [REV], row: [], publishRequest: [], hydrate: [] },
      metrics: ['storage_ops:get:unauthorized'],
    },
  },
  'approval-row read throws': {
    bridge: {
      result: { error: 'Error', message: 'replica unreachable' },
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    shared: {
      result: { error: 'Error', message: 'replica unreachable' },
      reads: { revocation: [], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    storage: {
      result: { error: 'Error', message: 'replica unreachable' },
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: ['storage_ops:get:error'],
    },
  },
  'dev token, no approval row': {
    bridge: {
      result: { ok: { scopes: ALL_SCOPES, buzzBudget: null } },
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    shared: {
      result: T('NOT_FOUND', 'app block not found'),
      reads: { revocation: [], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    storage: {
      result: T('NOT_FOUND', 'app block not found'),
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: ['storage_ops:get:not_found'],
    },
  },
  'dev token, owner, LIVE dev tunnel, row not approved': {
    bridge: {
      result: { ok: { scopes: ALL_SCOPES, buzzBudget: null } },
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    shared: {
      result: T('FORBIDDEN', 'app block is not approved'),
      reads: { revocation: [], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    storage: {
      result: T('FORBIDDEN', 'app block is not approved'),
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: ['storage_ops:get:unauthorized'],
    },
  },
  'dev token, owner, NO dev tunnel, row not approved': {
    bridge: {
      result: T('FORBIDDEN', 'app block is not approved'),
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    shared: {
      result: T('FORBIDDEN', 'app block is not approved'),
      reads: { revocation: [], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    storage: {
      result: T('FORBIDDEN', 'app block is not approved'),
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: ['storage_ops:get:unauthorized'],
    },
  },
  'dev token, NOT the owner, live tunnel, row not approved': {
    bridge: {
      result: T('FORBIDDEN', 'app block is not approved'),
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    shared: {
      result: T('FORBIDDEN', 'app block is not approved'),
      reads: { revocation: [], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    storage: {
      result: T('FORBIDDEN', 'app block is not approved'),
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: ['storage_ops:get:unauthorized'],
    },
  },
  'dev token, owner, dev-tunnel lookup throws, row not approved': {
    bridge: {
      result: T('FORBIDDEN', 'app block is not approved'),
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    shared: {
      result: T('FORBIDDEN', 'app block is not approved'),
      reads: { revocation: [], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    storage: {
      result: T('FORBIDDEN', 'app block is not approved'),
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: ['storage_ops:get:unauthorized'],
    },
  },
  'review token (dev, synthetic pending appId, no row)': {
    bridge: {
      result: { ok: { scopes: ALL_SCOPES, buzzBudget: null } },
      reads: {
        revocation: [REV],
        row: [{ appId_blockId: { appId: 'pending-01CHAR', blockId: 'char-block' } }],
        publishRequest: [],
        hydrate: [],
      },
      metrics: [],
    },
    shared: {
      result: T('NOT_FOUND', 'app block not found'),
      reads: {
        revocation: [],
        row: [{ appId_blockId: { appId: 'pending-01CHAR', blockId: 'char-block' } }],
        publishRequest: [],
        hydrate: [],
      },
      metrics: [],
    },
    storage: {
      result: T('NOT_FOUND', 'app block not found'),
      reads: {
        revocation: [REV],
        row: [{ appId_blockId: { appId: 'pending-01CHAR', blockId: 'char-block' } }],
        publishRequest: [],
        hydrate: [],
      },
      metrics: ['storage_ops:get:not_found'],
    },
  },
  'review run-for-real token (dev + reviewRunForReal), request pending': {
    bridge: {
      result: { ok: { scopes: ALL_SCOPES, buzzBudget: null } },
      reads: { revocation: [REV], row: [], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    shared: {
      result: T('NOT_FOUND', 'app block not found'),
      reads: {
        revocation: [],
        row: [{ appId_blockId: { appId: 'pending-01CHAR', blockId: 'char-block' } }],
        publishRequest: [],
        hydrate: [],
      },
      metrics: [],
    },
    storage: {
      result: {
        ok: {
          value: { value: 'stored-value' },
          query: { schema: '"apprev_pubreq_char"', params: ['bki_char', 42, 'k'] },
        },
      },
      reads: {
        revocation: [REV],
        row: [],
        publishRequest: [{ id: 'pubreq_01CHAR' }],
        hydrate: [42],
      },
      metrics: ['storage_ops:get:ok'],
    },
  },
  'review run-for-real token, request no longer pending': {
    bridge: {
      result: { ok: { scopes: ALL_SCOPES, buzzBudget: null } },
      reads: { revocation: [REV], row: [], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    shared: {
      result: T('NOT_FOUND', 'app block not found'),
      reads: {
        revocation: [],
        row: [{ appId_blockId: { appId: 'pending-01CHAR', blockId: 'char-block' } }],
        publishRequest: [],
        hydrate: [],
      },
      metrics: [],
    },
    storage: {
      result: T('FORBIDDEN', 'review preview is no longer active for this request'),
      reads: {
        revocation: [REV],
        row: [],
        publishRequest: [{ id: 'pubreq_01CHAR' }],
        hydrate: [42],
      },
      metrics: ['storage_ops:get:unauthorized'],
    },
  },
  'review run-for-real token, author flag off': {
    bridge: {
      result: { ok: { scopes: ALL_SCOPES, buzzBudget: null } },
      reads: { revocation: [REV], row: [], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    shared: {
      result: T('NOT_FOUND', 'app block not found'),
      reads: {
        revocation: [],
        row: [{ appId_blockId: { appId: 'pending-01CHAR', blockId: 'char-block' } }],
        publishRequest: [],
        hydrate: [],
      },
      metrics: [],
    },
    storage: {
      result: T('FORBIDDEN', 'Apps authoring is not enabled for this account'),
      reads: { revocation: [REV], row: [], publishRequest: [], hydrate: [42] },
      metrics: ['storage_ops:get:unauthorized'],
    },
  },
  'reviewRunForReal WITHOUT dev, row not approved': {
    bridge: {
      result: T('FORBIDDEN', 'app block is not approved'),
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    shared: {
      result: T('FORBIDDEN', 'app block is not approved'),
      reads: { revocation: [], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    storage: {
      result: {
        ok: {
          value: { value: 'stored-value' },
          query: { schema: '"apprev_pubreq_char"', params: ['bki_char', 42, 'k'] },
        },
      },
      reads: { revocation: [REV], row: [], publishRequest: [{ id: 'apb_claim' }], hydrate: [42] },
      metrics: ['storage_ops:get:ok'],
    },
  },
  'private-run token (owner audience), row not approved': {
    bridge: {
      result: { ok: { scopes: ALL_SCOPES, buzzBudget: null } },
      reads: { revocation: [REV], row: [], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    shared: {
      result: T('FORBIDDEN', 'app block is not approved'),
      reads: { revocation: [], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    storage: {
      result: T('FORBIDDEN', 'app block is not approved'),
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: ['storage_ops:get:unauthorized'],
    },
  },
  'private-run claim with NO audience, row not approved': {
    bridge: {
      result: T('FORBIDDEN', 'app block is not approved'),
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    shared: {
      result: T('FORBIDDEN', 'app block is not approved'),
      reads: { revocation: [], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    storage: {
      result: T('FORBIDDEN', 'app block is not approved'),
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: ['storage_ops:get:unauthorized'],
    },
  },
  'missing scope — read (token carries no scopes)': {
    bridge: {
      result: { ok: { scopes: [], buzzBudget: null } },
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    shared: {
      result: T('FORBIDDEN', 'shared storage get requires the apps:storage:shared:read scope'),
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    storage: {
      result: T('FORBIDDEN', 'storage get requires the apps:storage:read scope'),
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: ['storage_ops:get:unauthorized'],
    },
  },
  'missing scope — write (token carries only the read scopes)': {
    bridge: {
      result: {
        ok: {
          scopes: ['apps:storage:read', 'apps:storage:shared:read', 'buzz:read:self'],
          buzzBudget: null,
        },
      },
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    shared: {
      result: T('FORBIDDEN', 'shared storage append requires the apps:storage:shared:write scope'),
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    storage: {
      result: T('FORBIDDEN', 'storage set requires the apps:storage:write scope'),
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: ['storage_ops:set:unauthorized'],
    },
  },
  'consent revoked for posts:write:self + buzz:read:self': {
    bridge: {
      result: {
        ok: {
          scopes: [
            'apps:storage:read',
            'apps:storage:write',
            'apps:storage:shared:read',
            'apps:storage:shared:write',
            'models:read:self',
          ],
          buzzBudget: null,
        },
      },
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: ['consent_strip:bridge:buzz:read:self,posts:write:self'],
    },
    shared: {
      result: {
        ok: {
          userId: 42,
          subjectUser: { id: 42 },
          slug: 'char_block',
          schema: '"app_char_block"',
          appBlockId: 'apb_row',
          blockInstanceId: 'bki_char',
        },
      },
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [42] },
      metrics: [],
    },
    storage: {
      result: {
        ok: {
          value: { value: 'stored-value' },
          query: { schema: '"app_char_block"', params: ['bki_char', 42, 'k'] },
        },
      },
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [42] },
      metrics: ['storage_ops:get:ok'],
    },
  },
  'consent marker unreadable': {
    bridge: {
      result: T(
        'SERVICE_UNAVAILABLE',
        'permission state is temporarily unavailable — retry shortly'
      ),
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: ['consent_marker_unavailable:bridge'],
    },
    shared: {
      result: {
        ok: {
          userId: 42,
          subjectUser: { id: 42 },
          slug: 'char_block',
          schema: '"app_char_block"',
          appBlockId: 'apb_row',
          blockInstanceId: 'bki_char',
        },
      },
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [42] },
      metrics: [],
    },
    storage: {
      result: {
        ok: {
          value: { value: 'stored-value' },
          query: { schema: '"app_char_block"', params: ['bki_char', 42, 'k'] },
        },
      },
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [42] },
      metrics: ['storage_ops:get:ok'],
    },
  },
  'anonymous subject — read': {
    bridge: {
      result: { ok: { scopes: ALL_SCOPES, buzzBudget: null } },
      reads: { revocation: [['bki_char', 'anon']], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    shared: {
      result: T('FORBIDDEN', 'shared storage is not enabled'),
      reads: { revocation: [['bki_char', 'anon']], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    storage: {
      result: { ok: { value: { value: null }, query: null } },
      reads: { revocation: [['bki_char', 'anon']], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: ['storage_ops:get:ok'],
    },
  },
  'anonymous subject — read, flags base-enabled (the GA shape)': {
    bridge: {
      result: { ok: { scopes: ALL_SCOPES, buzzBudget: null } },
      reads: { revocation: [['bki_char', 'anon']], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    shared: {
      result: {
        ok: {
          userId: null,
          subjectUser: null,
          slug: 'char_block',
          schema: '"app_char_block"',
          appBlockId: 'apb_row',
          blockInstanceId: 'bki_char',
        },
      },
      reads: { revocation: [['bki_char', 'anon']], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    storage: {
      result: { ok: { value: { value: null }, query: null } },
      reads: { revocation: [['bki_char', 'anon']], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: ['storage_ops:get:ok'],
    },
  },
  'anonymous subject — write, flags base-enabled': {
    bridge: {
      result: { ok: { scopes: ALL_SCOPES, buzzBudget: null } },
      reads: { revocation: [['bki_char', 'anon']], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    shared: {
      result: T('UNAUTHORIZED', 'shared storage writes require an authenticated viewer'),
      reads: { revocation: [['bki_char', 'anon']], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    storage: {
      result: T('UNAUTHORIZED', 'storage requires an authenticated viewer'),
      reads: { revocation: [['bki_char', 'anon']], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: ['storage_ops:set:unauthorized'],
    },
  },
  'subject that will not hydrate': {
    bridge: {
      result: { ok: { scopes: ALL_SCOPES, buzzBudget: null } },
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    shared: {
      result: T('FORBIDDEN', 'token subject could not be resolved'),
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [42] },
      metrics: [],
    },
    storage: {
      result: T('UNAUTHORIZED', 'block token subject could not be resolved'),
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [42] },
      metrics: ['storage_ops:get:unauthorized'],
    },
  },
  'malformed sub (only reachable past a mocked verifier)': {
    bridge: {
      result: { error: 'ForbiddenError', message: 'malformed sub claim' },
      reads: { revocation: [], row: [], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    shared: {
      result: T('FORBIDDEN', 'invalid token subject'),
      reads: {
        revocation: [['bki_char', 'user:abc']],
        row: [ROW],
        publishRequest: [],
        hydrate: [],
      },
      metrics: [],
    },
    storage: {
      result: { error: 'ForbiddenError', message: 'malformed sub claim' },
      reads: {
        revocation: [['bki_char', 'user:abc']],
        row: [ROW],
        publishRequest: [],
        hydrate: [],
      },
      metrics: ['storage_ops:get:error'],
    },
  },
  'flag off (run flag / shared-storage flag)': {
    bridge: {
      result: { ok: { scopes: ALL_SCOPES, buzzBudget: null } },
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    shared: {
      result: T('FORBIDDEN', 'shared storage is not enabled'),
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [42] },
      metrics: [],
    },
    storage: {
      result: T('UNAUTHORIZED', 'Apps are not enabled'),
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [42] },
      metrics: ['storage_ops:get:unauthorized'],
    },
  },
  'shared write by an untrusted (new) account': {
    bridge: {
      result: { ok: { scopes: ALL_SCOPES, buzzBudget: null } },
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [] },
      metrics: [],
    },
    shared: {
      result: T('FORBIDDEN', 'Your account is too new to contribute'),
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [42] },
      metrics: [],
    },
    storage: {
      result: { error: 'Error', message: 'PAST_RESOLVER: reached the apps-db pool' },
      reads: { revocation: [REV], row: [ROW], publishRequest: [], hydrate: [42] },
      metrics: ['storage_ops:set:error'],
    },
  },
};

describe('block-token resolvers — characterisation table', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('the table has exactly one row per scenario, and no stale rows', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(SCENARIOS.map((s) => s.name).sort());
  });

  for (const s of SCENARIOS) {
    it(`${s.name} [${s.op}]`, async () => {
      const got = await cellsFor(s);
      expect(got).toEqual(EXPECTED[s.name]);
    });
  }
});

/**
 * `assertAppBlocksEnabledForTokenUser` — the hydration + run-flag gate most bridge procedures
 * call AFTER the bridge resolver. Pinned separately because it is not one of the three
 * resolvers, but the "unhydratable subject" and "flag off" columns of the bridge only exist
 * here. Compare with storage's own copy above: same code for the flag refusal, different
 * message for the hydration refusal ("block token subject …" vs "runtime block token subject …").
 */
describe('assertAppBlocksEnabledForTokenUser — characterisation', () => {
  const cases: Array<{ name: string; subject: unknown; flag: boolean; expected: unknown }> = [
    {
      name: 'hydrated subject, flag on',
      subject: TRUSTED_SUBJECT,
      flag: true,
      expected: { ok: undefined },
    },
    {
      name: 'subject that will not hydrate',
      subject: null,
      flag: true,
      expected: T('UNAUTHORIZED', 'runtime block token subject could not be resolved'),
    },
    {
      name: 'hydrated subject, run flag off',
      subject: TRUSTED_SUBJECT,
      flag: false,
      expected: T('UNAUTHORIZED', 'Apps are not enabled'),
    },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      h.getSessionUserById.mockImplementation(async (id: number) =>
        id === SUBJECT_ID ? c.subject : null
      );
      h.isAppBlocksEnabled.mockImplementation(
        async (opts?: { user?: { id?: number } }) => opts?.user?.id === SUBJECT_ID && c.flag
      );
      let got: unknown;
      try {
        got = { ok: await assertAppBlocksEnabledForTokenUser(SUBJECT_ID) };
      } catch (err) {
        got = describeError(err);
      }
      expect(got).toEqual(c.expected);
      expect(h.getSessionUserById).toHaveBeenCalledWith(SUBJECT_ID);
    });
  }
});
