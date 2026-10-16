import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClientModule from '~/server/flipt/client';
import {
  appSharedStorageLatencyHistogram,
  appSharedStorageOpsCounter,
} from '@civitai/telemetry/client';

/**
 * `civitai_app_block_shared_storage_{ops_total,latency_seconds}` as the router records them.
 *
 * Every case drives the REAL router and reads the REAL counter and histogram handles through call-
 * through spies, so "exactly once" means one `inc` and one `observe` per call, read off the
 * handles the scrape exposes. The mock harness follows `apps-shared.router.test.ts`: the pg pool,
 * token verifier, flags, rate limiters and subject hydration are stubbed; the content-safety belt
 * and counter-key detectors run for real.
 */

const {
  mockVerifyBlockToken,
  mockParseSubjectUserId,
  mockIsSharedEnabled,
  mockPool,
  mockClient,
  mockGetSessionUser,
  mockReserveWrite,
  mockCheckVoteRl,
  mockCheckReportRl,
  mockCheckWithdrawRl,
  mockAuditPromptServer,
  mockGetBlocklistData,
  mockIsFlipt,
  mockFindBlocked,
  mockIsRevoked,
  mockThrowOnBlocked,
  mockReleaseWrite,
} = vi.hoisted(() => {
  type QueryFn = (
    sql: string,
    params?: unknown[]
  ) => Promise<{
    rows: unknown[];
    rowCount: number;
  }>;
  type RateLimitFn = (
    userId: number,
    appBlockId: string
  ) => Promise<{ allowed: boolean; retryAfterSeconds?: number }>;
  const mockClient = {
    query: vi.fn<QueryFn>(async () => ({ rows: [], rowCount: 0 })),
    release: vi.fn(),
  };
  const mockPool = {
    connect: vi.fn(async () => mockClient),
    query: vi.fn<QueryFn>(async () => ({ rows: [], rowCount: 0 })),
  };
  return {
    mockVerifyBlockToken: vi.fn(),
    mockParseSubjectUserId: vi.fn(),
    mockIsSharedEnabled: vi.fn(async () => true),
    mockPool,
    mockClient,
    mockGetSessionUser: vi.fn(),
    mockReserveWrite: vi.fn<RateLimitFn>(async () => ({ allowed: true })),
    mockCheckVoteRl: vi.fn<RateLimitFn>(async () => ({ allowed: true })),
    mockCheckReportRl: vi.fn<RateLimitFn>(async () => ({ allowed: true })),
    mockCheckWithdrawRl: vi.fn<RateLimitFn>(async () => ({ allowed: true })),
    mockAuditPromptServer: vi.fn<(args: unknown) => Promise<void>>(async () => undefined),
    mockGetBlocklistData: vi.fn<(type: unknown) => Promise<unknown[]>>(async () => []),
    mockIsFlipt: vi.fn<(flag: string, entityId?: string, context?: unknown) => Promise<boolean>>(
      async () => false
    ),
    mockFindBlocked: vi.fn<(values: unknown, opts?: unknown) => Promise<unknown[]>>(async () => []),
    mockIsRevoked: vi.fn<() => Promise<boolean>>(async () => false),
    mockThrowOnBlocked: vi.fn<(values: unknown, opts: unknown) => Promise<void>>(
      async () => undefined
    ),
    mockReleaseWrite: vi.fn<(args: { rejected: boolean }) => Promise<void>>(async () => undefined),
  };
});

vi.mock('~/server/middleware/block-scope.middleware', () => ({
  verifyBlockToken: mockVerifyBlockToken,
  parseSubjectUserId: (...args: unknown[]) => mockParseSubjectUserId(...args),
  // The REST routes' scope middleware, as a pass-through that supplies claims.
  withBlockScope:
    (handler: (req: { blockClaims?: unknown }, res: unknown) => unknown) =>
    (req: { blockClaims?: unknown }, res: unknown) => {
      req.blockClaims = {};
      return handler(req, res);
    },
  stashBlockActionDetail: vi.fn(),
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (handler: unknown) => handler }));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksSharedStorageEnabled: mockIsSharedEnabled,
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: (...a: unknown[]) => mockGetSessionUser(...a) },
}));
vi.mock('~/server/db/appsDb', () => ({ requireAppsDb: () => mockPool }));
vi.mock('~/server/utils/shared-storage-rate-limit', () => ({
  reserveSharedWrite: async (userId: number, appBlockId: string) => {
    const r = await mockReserveWrite(userId, appBlockId);
    return r.allowed
      ? { allowed: true, release: (args: { rejected: boolean }) => mockReleaseWrite(args) }
      : r;
  },
  checkSharedVoteRateLimit: (userId: number, appBlockId: string) =>
    mockCheckVoteRl(userId, appBlockId),
  checkSharedReportRateLimit: (userId: number, appBlockId: string) =>
    mockCheckReportRl(userId, appBlockId),
  checkSharedWithdrawRateLimit: (userId: number, appBlockId: string) =>
    mockCheckWithdrawRl(userId, appBlockId),
}));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedUserContent: (values: unknown, opts: unknown) => mockThrowOnBlocked(values, opts),
  getBlocklistData: (type: unknown) => mockGetBlocklistData(type),
  findBlockedUserContent: (values: unknown, opts?: unknown) => mockFindBlocked(values, opts),
  stripBenignPhrases: async (text: string) => text,
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClientModule>()),
  isFlipt: (flag: string, entityId?: string, context?: unknown) =>
    mockIsFlipt(flag, entityId, context),
  getFliptBoolean: async () => false,
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { insert: async () => undefined } }));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  auditPromptServer: (args: unknown) => mockAuditPromptServer(args),
}));
vi.mock('~/server/services/block-revocation.service', () => ({
  BlockRevocation: { isRevoked: () => mockIsRevoked() },
}));
vi.mock('~/server/services/blocks/app-sub-listing.service', () => ({
  syncSubListingForSharedRow: async () => undefined,
}));

import {
  appendSharedRow,
  appsSharedRouter,
  getSharedCounts,
  getSharedRow,
  getTopSharedCounters,
  incrementSharedCounter,
  listSharedRows,
  reportSharedRow,
  unvoteSharedRow,
  updateSharedRow,
  voteSharedRow,
  withdrawSharedRow,
} from '../apps-shared.router';
import {
  SHARED_STORAGE_OPS,
  type SharedStorageOp,
  type SharedStorageOutcome,
} from '~/server/prom/app-block-shared-storage.metrics';
import listHandler from '~/pages/api/v1/blocks/shared-storage/list';
import topHandler from '~/pages/api/v1/blocks/shared-storage/top';
import incrementHandler from '~/pages/api/v1/blocks/shared-storage/increment';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { newUlid } from '~/server/utils/app-block-ids';
import { OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { TRPCError } from '@trpc/server';
import { isEscalatedServerFault } from '~/server/logging/server-fault-override';

const READ = 'apps:storage:shared:read';
const WRITE = 'apps:storage:shared:write';
const ENFORCE_FLAG = 'app-blocks-shared-data-moderation-enforce';
// Trips the real minor detector, as in `apps-shared.counters.test.ts`.
const FLAGGED_COUNTER_KEY = 'playcount:13 year old girl';
const APP_QUOTA_BYTES = 50 * 1024 * 1024;

function claims(over: Record<string, unknown> = {}) {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: 'user:42',
    iat: 0,
    exp: 0,
    jti: 'jti_test',
    blockId: 'app-voting',
    appId: 'app_test',
    appBlockId: 'apb_test',
    blockInstanceId: 'bki_inst',
    ctx: {},
    scopes: [READ, WRITE],
    ...over,
  };
}

function trustedUser(over: Record<string, unknown> = {}) {
  return {
    id: 42,
    isModerator: false,
    bannedAt: null,
    muted: false,
    onboarding: OnboardingSteps.Buzz,
    emailVerified: new Date('2020-01-01'),
    createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    ...over,
  };
}

function trpcCaller() {
  return appsSharedRouter.createCaller({
    acceptableOrigin: true,
    user: undefined,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: {},
    track: undefined,
  } as never);
}

type PoolRow = { rows: unknown[]; rowCount: number };

/** Answers `pool.query` by the first SQL fragment it contains; everything else is empty. */
function poolAnswers(answers: Array<[fragment: string, answer: PoolRow | (() => PoolRow)]>) {
  mockPool.query.mockImplementation(async (sql: string) => {
    for (const [fragment, answer] of answers) {
      if (sql.includes(fragment)) return typeof answer === 'function' ? answer() : answer;
    }
    return { rows: [], rowCount: 0 };
  });
}

const quotaRow = (usedBytes: number, storedSize = 10, rowCount = 0): [string, PoolRow] => [
  '.quota',
  {
    rows: [
      { used_bytes: String(usedBytes), row_count: String(rowCount), stored_size_bytes: storedSize },
    ],
    rowCount: 1,
  },
];
const appendDataPath = (rowCountForUser = 0, usedBytes = 0) =>
  poolAnswers([
    ['count(*)', { rows: [{ n: String(rowCountForUser) }], rowCount: 1 }],
    quotaRow(usedBytes),
  ]);
const existingRow = (authorUserId = 42) =>
  poolAnswers([
    [
      'SELECT author_user_id, size_bytes',
      { rows: [{ author_user_id: authorUserId, size_bytes: 5 }], rowCount: 1 },
    ],
    quotaRow(0),
  ]);

const oversizedValue = () => ({ title: 'hi', data: 'x'.repeat(70 * 1024) });
const unserializableValue = () => ({ title: 'hi', data: BigInt(1) as unknown });
const denyAll = { allowed: false, retryAfterSeconds: 30 };

let incSpy: ReturnType<typeof vi.spyOn>;
let observeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyBlockToken.mockResolvedValue(claims());
  mockParseSubjectUserId.mockImplementation((sub: string) =>
    sub === 'anon' ? null : Number(sub.split(':')[1])
  );
  mockGetSessionUser.mockResolvedValue(trustedUser());
  dbMock.dbRead.appBlock.findUnique.mockResolvedValue({ id: 'apb_test', status: 'approved' });
  dbMock.dbRead.account.count.mockResolvedValue(0);
  mockIsSharedEnabled.mockResolvedValue(true);
  mockPool.query.mockReset();
  mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  mockPool.connect.mockReset();
  mockPool.connect.mockResolvedValue(mockClient);
  mockClient.query.mockReset();
  mockClient.query.mockResolvedValue({ rows: [], rowCount: 0 });
  mockReserveWrite.mockResolvedValue({ allowed: true });
  mockCheckVoteRl.mockResolvedValue({ allowed: true });
  mockCheckReportRl.mockResolvedValue({ allowed: true });
  mockCheckWithdrawRl.mockResolvedValue({ allowed: true });
  mockAuditPromptServer.mockResolvedValue(undefined);
  mockGetBlocklistData.mockResolvedValue([]);
  mockIsFlipt.mockResolvedValue(false);
  mockFindBlocked.mockReset();
  mockFindBlocked.mockResolvedValue([]);
  mockIsRevoked.mockResolvedValue(false);
  mockThrowOnBlocked.mockReset();
  mockThrowOnBlocked.mockResolvedValue(undefined);

  incSpy = vi.spyOn(appSharedStorageOpsCounter, 'inc');
  observeSpy = vi.spyOn(appSharedStorageLatencyHistogram, 'observe');
});

afterEach(() => {
  incSpy.mockRestore();
  observeSpy.mockRestore();
});

/** The one (op, outcome) the call recorded, failing unless it recorded exactly one of each. */
function recordedExactlyOnce(): { op: string; outcome: string } {
  expect(incSpy, 'ops_total increments').toHaveBeenCalledTimes(1);
  expect(observeSpy, 'latency observations').toHaveBeenCalledTimes(1);
  const labels = incSpy.mock.calls[0][0] as { op: string; outcome: string };
  const [latencyLabels, seconds] = observeSpy.mock.calls[0] as [{ op: string }, number];
  expect(latencyLabels).toEqual({ op: labels.op });
  expect(seconds).toBeGreaterThanOrEqual(0);
  return labels;
}

type Case = {
  op: SharedStorageOp;
  outcome: SharedStorageOutcome;
  /** The refusal path, for the failure message. */
  path: string;
  arrange?: () => void;
  act: () => Promise<unknown>;
};

const COUNTER_KEY = 'playcount:7';
const ROW_KEY = 'k1';

/** One call per op, so a case only has to arrange what differs. */
const ACT: Record<SharedStorageOp, () => Promise<unknown>> = {
  list: () => listSharedRows('t', { limit: 10 }),
  get: () => getSharedRow('t', ROW_KEY),
  getCount: () => getSharedCounts('t', [ROW_KEY]),
  getTop: () => getTopSharedCounters('t', 'playcount:', 10),
  append: () => appendSharedRow('t', { title: 'hi' }),
  update: () => updateSharedRow('t', ROW_KEY, { title: 'hi' }),
  vote: () => voteSharedRow('t', ROW_KEY),
  unvote: () => unvoteSharedRow('t', ROW_KEY),
  withdraw: () => withdrawSharedRow('t', ROW_KEY),
  report: () => reportSharedRow('t', ROW_KEY),
  increment: () => incrementSharedCounter('t', COUNTER_KEY),
};

const WRITE_OPS = SHARED_STORAGE_OPS.filter(
  (op) => !['list', 'get', 'getCount', 'getTop'].includes(op)
);

/** The rate limit each write takes, in the order the router consults them. */
const RATE_LIMIT: Partial<Record<SharedStorageOp, () => void>> = {
  append: () => mockReserveWrite.mockResolvedValueOnce(denyAll),
  update: () => {
    existingRow();
    mockReserveWrite.mockResolvedValueOnce(denyAll);
  },
  vote: () => mockCheckVoteRl.mockResolvedValueOnce(denyAll),
  unvote: () => mockCheckVoteRl.mockResolvedValueOnce(denyAll),
  increment: () => mockCheckVoteRl.mockResolvedValueOnce(denyAll),
  withdraw: () => mockCheckWithdrawRl.mockResolvedValueOnce(denyAll),
  report: () => mockCheckReportRl.mockResolvedValueOnce(denyAll),
};

const SUCCESS: Record<SharedStorageOp, () => void> = {
  list: () => undefined,
  get: () => undefined,
  getCount: () => undefined,
  getTop: () => undefined,
  append: () => appendDataPath(),
  update: () => {
    existingRow();
    mockClient.query.mockResolvedValue({ rows: [], rowCount: 1 });
  },
  vote: () =>
    poolAnswers([
      ['SELECT 1', { rows: [{}], rowCount: 1 }],
      ['votes', { rows: [{ count: '1' }], rowCount: 1 }],
    ]),
  unvote: () => undefined,
  withdraw: () => undefined,
  report: () => poolAnswers([['SELECT 1', { rows: [{}], rowCount: 1 }]]),
  increment: () => undefined,
};

const enforceCounterKeys = () =>
  mockIsFlipt.mockImplementation(async (flag: string) => flag === ENFORCE_FLAG);
/** Enforce mode with an insert that would create the key, so the key is scanned. */
const creatingIncrement = () => {
  enforceCounterKeys();
  mockClient.query.mockResolvedValue({ rows: [{ count: '1' }], rowCount: 1 });
};

const CASES: Case[] = [
  ...SHARED_STORAGE_OPS.flatMap((op): Case[] => [
    { op, outcome: 'ok', path: 'success', arrange: SUCCESS[op], act: ACT[op] },
    {
      op,
      outcome: 'unauthorized',
      path: 'invalid block token',
      arrange: () => mockVerifyBlockToken.mockResolvedValueOnce(null),
      act: ACT[op],
    },
    {
      op,
      outcome: 'disabled',
      path: 'shared storage flag off',
      arrange: () => mockIsSharedEnabled.mockResolvedValueOnce(false),
      act: ACT[op],
    },
    {
      op,
      outcome: 'error',
      path: 'subject hydration throws',
      arrange: () => mockGetSessionUser.mockRejectedValueOnce(new Error('session store down')),
      act: ACT[op],
    },
  ]),
  ...WRITE_OPS.flatMap((op): Case[] => [
    {
      op,
      outcome: 'trust_refused',
      path: 'assertSharedWriteTrust (account too new)',
      arrange: () =>
        mockGetSessionUser.mockResolvedValueOnce(trustedUser({ createdAt: new Date() })),
      act: ACT[op],
    },
    {
      op,
      outcome: 'rate_limited',
      path: 'throwSharedRateLimited',
      arrange: RATE_LIMIT[op],
      act: ACT[op],
    },
  ]),

  // append
  {
    op: 'append',
    outcome: 'bad_request',
    path: 'value is not serializable',
    act: () => appendSharedRow('t', unserializableValue()),
  },
  {
    op: 'append',
    outcome: 'moderation_blocked',
    path: 'title/body belt: platform audit block',
    arrange: () => mockAuditPromptServer.mockRejectedValueOnce(new Error('blocked')),
    act: ACT.append,
  },
  {
    op: 'append',
    outcome: 'moderation_unavailable',
    path: 'title/body belt: blocklist read failed',
    arrange: () => mockGetBlocklistData.mockRejectedValueOnce(new Error('cache down')),
    act: ACT.append,
  },
  {
    op: 'append',
    outcome: 'payload_too_large',
    path: 'SHARED_VALUE_BYTE_CAP',
    act: () => appendSharedRow('t', oversizedValue()),
  },
  {
    op: 'append',
    outcome: 'user_row_cap_exceeded',
    path: 'SHARED_KV_PER_USER_ROW_CAP',
    arrange: () => appendDataPath(50),
    act: ACT.append,
  },
  {
    op: 'append',
    outcome: 'quota_exceeded',
    path: 'APP_QUOTA_BYTES',
    arrange: () => appendDataPath(0, APP_QUOTA_BYTES),
    act: ACT.append,
  },

  // update
  {
    op: 'update',
    outcome: 'not_found',
    path: 'row missing or hidden',
    act: ACT.update,
  },
  {
    op: 'update',
    outcome: 'forbidden',
    path: 'not the author',
    arrange: () => existingRow(7),
    act: ACT.update,
  },
  {
    op: 'update',
    outcome: 'bad_request',
    path: 'value is not serializable',
    arrange: () => existingRow(),
    act: () => updateSharedRow('t', ROW_KEY, unserializableValue()),
  },
  {
    op: 'update',
    outcome: 'moderation_blocked',
    path: 'title/body belt: platform audit block',
    arrange: () => {
      existingRow();
      mockAuditPromptServer.mockRejectedValueOnce(new Error('blocked'));
    },
    act: ACT.update,
  },
  {
    op: 'update',
    outcome: 'moderation_unavailable',
    path: 'title/body belt: blocklist read failed',
    arrange: () => {
      existingRow();
      mockGetBlocklistData.mockRejectedValueOnce(new Error('cache down'));
    },
    act: ACT.update,
  },
  {
    op: 'update',
    outcome: 'payload_too_large',
    path: 'SHARED_VALUE_BYTE_CAP',
    arrange: () => existingRow(),
    act: () => updateSharedRow('t', ROW_KEY, oversizedValue()),
  },
  {
    op: 'update',
    outcome: 'quota_exceeded',
    path: 'APP_QUOTA_BYTES on the growth delta',
    arrange: () =>
      poolAnswers([
        [
          'SELECT author_user_id, size_bytes',
          { rows: [{ author_user_id: 42, size_bytes: 5 }], rowCount: 1 },
        ],
        quotaRow(APP_QUOTA_BYTES, 500),
      ]),
    act: ACT.update,
  },

  // Every other `unauthorized` / token-refusal path, on one read and one write.
  {
    op: 'get',
    outcome: 'unauthorized',
    path: 'block instance revoked',
    arrange: () => mockIsRevoked.mockResolvedValueOnce(true),
    act: ACT.get,
  },
  {
    op: 'get',
    outcome: 'unauthorized',
    path: "token's app block not found",
    arrange: () => dbMock.dbRead.appBlock.findUnique.mockResolvedValueOnce(null),
    act: ACT.get,
  },
  {
    op: 'get',
    outcome: 'unauthorized',
    path: "token's app block not approved",
    arrange: () =>
      dbMock.dbRead.appBlock.findUnique.mockResolvedValueOnce({ id: 'apb_x', status: 'pending' }),
    act: ACT.get,
  },
  {
    op: 'get',
    outcome: 'unauthorized',
    path: 'read scope missing',
    arrange: () => mockVerifyBlockToken.mockResolvedValueOnce(claims({ scopes: [WRITE] })),
    act: ACT.get,
  },
  {
    op: 'get',
    outcome: 'unauthorized',
    path: 'token subject malformed',
    arrange: () =>
      mockParseSubjectUserId.mockImplementationOnce(() => {
        throw new Error('bad sub');
      }),
    act: ACT.get,
  },
  {
    op: 'get',
    outcome: 'unauthorized',
    path: 'token subject no longer resolves',
    arrange: () => mockGetSessionUser.mockResolvedValueOnce(null),
    act: ACT.get,
  },
  {
    op: 'get',
    outcome: 'error',
    path: 'token block id is not a storage slug',
    arrange: () => mockVerifyBlockToken.mockResolvedValueOnce(claims({ blockId: '!!!' })),
    act: ACT.get,
  },
  {
    op: 'withdraw',
    outcome: 'unauthorized',
    path: 'anonymous write',
    arrange: () => mockVerifyBlockToken.mockResolvedValueOnce(claims({ sub: 'anon' })),
    act: ACT.withdraw,
  },
  {
    op: 'withdraw',
    outcome: 'unauthorized',
    path: 'write scope missing',
    arrange: () => mockVerifyBlockToken.mockResolvedValueOnce(claims({ scopes: [READ] })),
    act: ACT.withdraw,
  },
  {
    op: 'append',
    outcome: 'quota_exceeded',
    path: 'APP_ROW_LIMIT',
    arrange: () =>
      poolAnswers([['count(*)', { rows: [{ n: '0' }], rowCount: 1 }], quotaRow(0, 10, 1_000_000)]),
    act: ACT.append,
  },

  // vote / report
  { op: 'vote', outcome: 'not_found', path: 'row missing or hidden', act: ACT.vote },
  { op: 'report', outcome: 'not_found', path: 'row missing', act: ACT.report },

  // increment
  {
    op: 'increment',
    outcome: 'bad_request',
    path: 'assertValidCounterKey (feed-row-shaped key)',
    act: () => incrementSharedCounter('t', newUlid()),
  },
  {
    op: 'increment',
    outcome: 'moderation_blocked',
    path: 'refuseSharedTextHit (counter key)',
    arrange: creatingIncrement,
    act: () => incrementSharedCounter('t', FLAGGED_COUNTER_KEY),
  },
  {
    op: 'increment',
    outcome: 'moderation_unavailable',
    path: 'enforceScan (counter-key scan failed)',
    arrange: () => {
      creatingIncrement();
      mockFindBlocked.mockRejectedValueOnce(new Error('cache down'));
    },
    act: ACT.increment,
  },
];

describe('every shared storage call records one (op, outcome) and one latency sample', () => {
  it.each(CASES.map((c) => [`${c.op} → ${c.outcome} (${c.path})`, c] as const))(
    '%s',
    async (_name, c) => {
      c.arrange?.();
      const settled = await c.act().then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error })
      );
      expect(settled.ok, `call ${c.outcome === 'ok' ? 'resolves' : 'rejects'}`).toBe(
        c.outcome === 'ok'
      );
      expect(recordedExactlyOnce()).toEqual({ op: c.op, outcome: c.outcome });
    }
  );
});

describe('a thrown error is recorded once and reaches the caller unchanged', () => {
  it('a database failure mid-read records `error` once and rethrows the same object', async () => {
    const failure = new Error('connection reset');
    mockPool.query.mockRejectedValueOnce(failure);
    await expect(listSharedRows('t', { limit: 10 })).rejects.toBe(failure);
    expect(recordedExactlyOnce()).toEqual({ op: 'list', outcome: 'error' });
  });

  it('a failed COMMIT mid-write records `error` once and rethrows the same object', async () => {
    appendDataPath();
    const failure = new Error('commit failed');
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql === 'COMMIT') throw failure;
      return { rows: [], rowCount: 1 };
    });
    await expect(appendSharedRow('t', { title: 'hi' })).rejects.toBe(failure);
    expect(recordedExactlyOnce()).toEqual({ op: 'append', outcome: 'error' });
  });

  it.each(['inc', 'observe'] as const)(
    'a metrics handle whose `%s` throws changes neither the result nor the error',
    async (method) => {
      const spy = method === 'inc' ? incSpy : observeSpy;
      spy.mockImplementation(() => {
        throw new Error('registry broken');
      });
      await expect(listSharedRows('t', { limit: 10 })).resolves.toEqual({
        items: [],
        nextCursor: undefined,
      });
      expect(spy, 'the throwing handle was reached').toHaveBeenCalled();

      const failure = new Error('connection reset');
      mockPool.query.mockRejectedValueOnce(failure);
      await expect(listSharedRows('t', { limit: 10 })).rejects.toBe(failure);
    }
  );
});

describe('the title/body blocklist scan: a throw is unavailable moderation, a hit is a block', () => {
  // The belt refuses text whose scan THREW with the same response as before this outcome existed
  // (a charged 400 with a retry message, no Report). Only the recorded outcome tells it apart from
  // a scan that found something. The audit block is the positive control for the Report check.
  const RETRY = 'Content could not be reviewed right now. Please try again.';
  const scanThrows = () => mockThrowOnBlocked.mockRejectedValueOnce(new TypeError('bad entry'));
  const scanHitsPattern = () =>
    mockThrowOnBlocked.mockImplementationOnce(async (_values, opts) => {
      (opts as { onBlocked: (kind: 'link' | 'pattern') => void }).onBlocked('pattern');
    });
  const auditBlocks = () => mockAuditPromptServer.mockRejectedValueOnce(new Error('blocked'));

  const ROWS: Array<
    [
      path: string,
      arrange: () => void,
      expected: { outcome: SharedStorageOutcome; message: string; reportFiled: boolean }
    ]
  > = [
    [
      'scan throws',
      scanThrows,
      { outcome: 'moderation_unavailable', message: RETRY, reportFiled: false },
    ],
    [
      'scan finds a blocked pattern',
      scanHitsPattern,
      { outcome: 'moderation_blocked', message: 'Content flagged for review', reportFiled: false },
    ],
    [
      'platform audit blocks',
      auditBlocks,
      { outcome: 'moderation_blocked', message: 'blocked', reportFiled: true },
    ],
  ];
  const OPS: Array<[op: 'append' | 'update', arrange: () => void]> = [
    ['append', () => appendDataPath()],
    ['update', () => existingRow()],
  ];

  it.each(OPS.flatMap(([op, arrangeOp]) => ROWS.map((row) => [op, ...row, arrangeOp] as const)))(
    '%s, %s',
    async (op, _path, arrange, expected, arrangeOp) => {
      arrangeOp();
      arrange();
      const error = await ACT[op]().then(
        () => undefined,
        (e: unknown) => e
      );

      expect(error).toBeInstanceOf(TRPCError);
      expect(error).toMatchObject({ code: 'BAD_REQUEST', message: expected.message });
      expect(isEscalatedServerFault(error), 'not escalated').toBe(false);
      expect(mockReleaseWrite.mock.calls, 'charged to the rejection bucket').toEqual([
        [{ rejected: true }],
      ]);
      const reports = mockPool.query.mock.calls.filter(([sql]) =>
        String(sql).includes('shared_kv_reports')
      );
      expect(reports.length, 'Report rows filed').toBe(expected.reportFiled ? 1 : 0);
      expect(recordedExactlyOnce()).toEqual({ op, outcome: expected.outcome });
    }
  );
});

describe('both transports record once per call', () => {
  function restRes() {
    const sent: { status?: number; body?: unknown } = {};
    const res = {
      status(code: number) {
        sent.status = code;
        return res;
      },
      json(body: unknown) {
        sent.body = body;
        return res;
      },
      setHeader() {
        return res;
      },
    };
    return { res, sent };
  }
  const bearer = { authorization: 'Bearer t' };

  it('tRPC `append` records once, including its refusal', async () => {
    mockReserveWrite.mockResolvedValueOnce(denyAll);
    await expect(
      trpcCaller().append({ blockToken: 't', value: { title: 'hi' } })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(recordedExactlyOnce()).toEqual({ op: 'append', outcome: 'rate_limited' });
  });

  it('REST `list` with `mine=true` records once as op `list`', async () => {
    const { res, sent } = restRes();
    await listHandler(
      { method: 'GET', query: { mine: 'true' }, headers: bearer } as never,
      res as never
    );
    expect(sent.status).toBe(200);
    expect(recordedExactlyOnce()).toEqual({ op: 'list', outcome: 'ok' });
  });

  it('REST `top` records once as op `getTop`', async () => {
    const { res, sent } = restRes();
    await topHandler(
      { method: 'GET', query: { prefix: 'playcount:' }, headers: bearer } as never,
      res as never
    );
    expect(sent.status).toBe(200);
    expect(recordedExactlyOnce()).toEqual({ op: 'getTop', outcome: 'ok' });
  });

  it('REST `increment` records its refusal once, with the status unchanged', async () => {
    const { res, sent } = restRes();
    await incrementHandler(
      { method: 'POST', body: { key: newUlid() }, headers: bearer } as never,
      res as never
    );
    expect(sent).toEqual({ status: 400, body: { error: 'invalid counter key' } });
    expect(recordedExactlyOnce()).toEqual({ op: 'increment', outcome: 'bad_request' });
  });

  it('a REST request refused by its own input validation never reaches the op, so records nothing', async () => {
    const { res, sent } = restRes();
    await incrementHandler({ method: 'POST', body: {}, headers: bearer } as never, res as never);
    expect(sent.status).toBe(400);
    expect(incSpy).not.toHaveBeenCalled();
    expect(observeSpy).not.toHaveBeenCalled();
  });
});
