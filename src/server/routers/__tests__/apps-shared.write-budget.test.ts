import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { TRPCError } from '@trpc/server';
import { createTRPCClient, httpLink, TRPCClientError } from '@trpc/client';
import type * as FliptClientModule from '~/server/flipt/client';
import type * as RateLimitModule from '~/server/utils/shared-storage-rate-limit';
import { dbMock, redisMock, resetSharedMocks } from '~/__tests__/mocks';
import { REDIS_KEYS } from '~/server/redis/client';
import { clientTransformer } from '~/shared/utils/trpc-union-transformer';
import { OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { createLuaRedis, type LuaRedis } from '~/server/utils/__tests__/redis-lua-harness';

/**
 * The append/update write budget end to end: the REAL router bodies, the REAL limiter, and its
 * Lua script EXECUTED (wasmoon) against an in-memory store. Only the database, the token
 * verifier and the moderation backends are mocked. Assertions read the stored bucket state, so
 * "a blocked write does not consume the budget" is measured, not inferred from a mock call.
 */

const {
  mockVerifyBlockToken,
  mockPool,
  mockClient,
  mockGetSessionUser,
  mockIsRevoked,
  mockIsFlipt,
  mockFindBlocked,
} = vi.hoisted(() => {
  type QueryFn = (
    sql: string,
    params?: unknown[]
  ) => Promise<{ rows: unknown[]; rowCount: number }>;
  const mockClient = {
    query: vi.fn<QueryFn>(async () => ({ rows: [], rowCount: 0 })),
    release: vi.fn<() => void>(),
  };
  return {
    mockVerifyBlockToken: vi.fn(),
    mockPool: {
      connect: vi.fn(async () => mockClient),
      query: vi.fn<QueryFn>(async () => ({ rows: [], rowCount: 0 })),
    },
    mockClient,
    mockGetSessionUser: vi.fn(),
    mockIsRevoked: vi.fn<(blockInstanceId: string, sub?: string) => Promise<boolean>>(
      async () => false
    ),
    mockIsFlipt: vi.fn<(flag: string) => Promise<boolean>>(async () => false),
    mockFindBlocked: vi.fn<() => Promise<unknown[]>>(async () => []),
  };
});

vi.mock('~/server/middleware/block-scope.middleware', () => ({
  verifyBlockToken: (token: string) => mockVerifyBlockToken(token),
  parseSubjectUserId: (sub: string) => Number(sub.split(':')[1]),
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksSharedStorageEnabled: async () => true,
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: (id: number) => mockGetSessionUser(id) },
}));
vi.mock('~/server/db/appsDb', () => ({ requireAppsDb: () => mockPool }));
// The write budget stays REAL; only the fixed-window siblings are stubbed open.
vi.mock('~/server/utils/shared-storage-rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof RateLimitModule>()),
  checkSharedVoteRateLimit: async () => ({ allowed: true }),
  checkSharedReportRateLimit: async () => ({ allowed: true }),
  checkSharedWithdrawRateLimit: async () => ({ allowed: true }),
}));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedUserContent: async () => undefined,
  findBlockedUserContent: () => mockFindBlocked(),
  stripBenignPhrases: async (text: string) => text,
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClientModule>()),
  isFlipt: (flag: string) => mockIsFlipt(flag),
  getFliptBoolean: async () => false,
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { insert: async () => undefined } }));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  auditPromptServer: async () => undefined,
}));
vi.mock('~/server/services/block-revocation.service', () => ({
  BlockRevocation: {
    isRevoked: (blockInstanceId: string, sub?: string) => mockIsRevoked(blockInstanceId, sub),
  },
}));
vi.mock('~/server/services/blocks/app-sub-listing.service', () => ({
  syncSubListingForSharedRow: async () => undefined,
}));

import {
  appendSharedRow,
  appsSharedRouter,
  updateSharedRow,
  withdrawSharedRow,
} from '../apps-shared.router';

const T0 = Date.parse('2033-03-04T05:06:07.000Z') + 271;
const KEY = `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:shared-write:v2:apb_test:42`;
// Production buckets (SHARED_WRITE_BUDGET), in ms.
const BURST_MS = 360_000;
const DAILY_MS = 1_728_000;
const REJECT_MS = 1_800_000;
// Trips the real minor detector in the content-safety belt → BAD_REQUEST.
const BLOCKED = { title: '13 year old girl' };
const CLEAN = { title: 'a clean idea 7741' };

let lua: LuaRedis;

beforeEach(() => {
  vi.clearAllMocks();
  resetSharedMocks();
  lua = createLuaRedis(T0);
  redisMock.redis.eval.mockImplementation(
    (script: string, options: { keys: string[]; arguments: string[] }) => lua.eval(script, options)
  );
  mockVerifyBlockToken.mockResolvedValue({
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
    scopes: ['apps:storage:shared:read', 'apps:storage:shared:write'],
  });
  mockGetSessionUser.mockResolvedValue({
    id: 42,
    isModerator: false,
    bannedAt: null,
    muted: false,
    onboarding: OnboardingSteps.Buzz,
    emailVerified: new Date('2020-01-01'),
    createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  });
  dbMock.dbRead.appBlock.findUnique.mockResolvedValue({ id: 'apb_test', status: 'approved' });
  dbMock.dbRead.account.count.mockResolvedValue(0);
  mockIsFlipt.mockResolvedValue(false);
  mockFindBlocked.mockResolvedValue([]);
  mockWritePath({});
});

afterEach(() => {
  expect(lua.errors).toEqual([]);
  vi.useRealTimers();
});

/** Append/update data path: row count, quota, the existing row, and the UPDATE's row count. */
function mockWritePath({
  userRows = 0,
  existingRow = true,
  updatedRows = 1,
}: {
  userRows?: number;
  existingRow?: boolean;
  updatedRows?: number;
}) {
  mockPool.query.mockImplementation(async (sql: string) => {
    if (sql.includes('count(*)')) return { rows: [{ n: String(userRows) }], rowCount: 1 };
    if (sql.includes('.quota'))
      return {
        rows: [{ used_bytes: '0', row_count: '0', stored_size_bytes: 97 }],
        rowCount: 1,
      };
    if (sql.includes('author_user_id, size_bytes'))
      return existingRow
        ? { rows: [{ author_user_id: 42, size_bytes: 89 }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  });
  mockClient.query.mockImplementation(async (sql: string) => {
    if (sql.trim().startsWith('UPDATE')) return { rows: [], rowCount: updatedRows };
    if (sql.trim().startsWith('DELETE')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
}

/** The stored bucket state as offsets from T0: [burst, daily, rejections]; 0 = full. */
function budget() {
  const h = lua.hash(KEY);
  if (!h) return [0, 0, 0];
  return [h.b, h.d, h.r].map((v) => Math.max(0, Number(v) - lua.nowMs));
}

async function codeOf(p: Promise<unknown>) {
  return p.then(
    () => 'OK',
    (e: { code?: string }) => e.code ?? 'UNKNOWN'
  );
}

describe('write budget: only landed writes spend it', () => {
  it('a landed append spends one write token and no rejection', async () => {
    await expect(appendSharedRow('tok', CLEAN)).resolves.toMatchObject({ key: expect.any(String) });
    expect(budget()).toEqual([BURST_MS, DAILY_MS, 0]);
  });

  it('a moderation-blocked append refunds the write token and charges one rejection', async () => {
    expect(await codeOf(appendSharedRow('tok', BLOCKED))).toBe('BAD_REQUEST');
    expect(budget()).toEqual([0, 0, REJECT_MS]);
  });

  it('a row-cap refusal refunds and charges one rejection', async () => {
    mockWritePath({ userRows: 50 });
    expect(await codeOf(appendSharedRow('tok', CLEAN))).toBe('FORBIDDEN');
    expect(budget()).toEqual([0, 0, REJECT_MS]);
  });

  it('an update on a missing row (NOT_FOUND) refunds and charges one rejection', async () => {
    mockWritePath({ existingRow: false });
    expect(await codeOf(updateSharedRow('tok', 'ROW-404', CLEAN))).toBe('NOT_FOUND');
    expect(budget()).toEqual([0, 0, REJECT_MS]);
  });

  it('an update that loses the race (UPDATE hits 0 rows) refunds', async () => {
    mockWritePath({ updatedRows: 0 });
    expect(await codeOf(updateSharedRow('tok', 'ROW-1', CLEAN))).toBe('NOT_FOUND');
    expect(budget()).toEqual([0, 0, REJECT_MS]);
  });

  it('a failed COMMIT refunds the write token and charges no rejection (server fault)', async () => {
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql === 'COMMIT') throw new Error('connection reset');
      return { rows: [], rowCount: 0 };
    });
    await expect(appendSharedRow('tok', CLEAN)).rejects.toThrow('connection reset');
    expect(budget()).toEqual([0, 0, 0]);
  });

  it('an update whose COMMIT fails refunds the write token and charges no rejection', async () => {
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql === 'COMMIT') throw new Error('connection reset');
      if (sql.trim().startsWith('UPDATE')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    await expect(updateSharedRow('tok', 'ROW-1', CLEAN)).rejects.toThrow('connection reset');
    expect(budget()).toEqual([0, 0, 0]);
  });

  it('a 5xx TRPCError before the write lands refunds without charging a rejection', async () => {
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql.trim().startsWith('INSERT INTO')) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'insert failed' });
      }
      return { rows: [], rowCount: 0 };
    });
    expect(await codeOf(appendSharedRow('tok', CLEAN))).toBe('INTERNAL_SERVER_ERROR');
    expect(budget()).toEqual([0, 0, 0]);
  });

  it('a 4xx that is our outage (the enforced data scan failing) charges no rejection', async () => {
    mockIsFlipt.mockImplementation(async (flag: string) => flag.endsWith('enforce'));
    mockFindBlocked.mockRejectedValue(new Error('blocklist down'));
    await expect(
      appendSharedRow('tok', { ...CLEAN, data: { note: 'a calm lake' } })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Content could not be reviewed right now. Please try again.',
    });
    expect(budget()).toEqual([0, 0, 0]);
  });

  it('a write that LANDED and then threw keeps its token spent', async () => {
    // After COMMIT the only code that can still throw is the connection release.
    mockClient.release.mockImplementationOnce(() => {
      throw new Error('release failed');
    });
    await expect(appendSharedRow('tok', CLEAN)).rejects.toThrow('release failed');
    expect(budget()).toEqual([BURST_MS, DAILY_MS, 0]);
  });

  it('withdraw never refunds', async () => {
    await appendSharedRow('tok', CLEAN);
    await expect(withdrawSharedRow('tok', 'ROW-1')).resolves.toMatchObject({ ok: true });
    expect(budget()).toEqual([BURST_MS, DAILY_MS, 0]);
  });
});

describe('write budget: refusals', () => {
  it('append and update share one budget', async () => {
    for (let i = 0; i < 5; i++) {
      await appendSharedRow('tok', CLEAN);
      await updateSharedRow('tok', 'ROW-1', CLEAN);
    }
    expect(budget()).toEqual([10 * BURST_MS, 10 * DAILY_MS, 0]);
    await expect(updateSharedRow('tok', 'ROW-1', CLEAN)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many submissions — retry in 360s',
    });
    await expect(appendSharedRow('tok', CLEAN)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
  });

  it('a refused call consumes nothing and runs no moderation or query', async () => {
    for (let i = 0; i < 10; i++) await appendSharedRow('tok', CLEAN);
    const before = { hash: lua.hash(KEY), pttl: lua.pttl(KEY) };
    mockPool.query.mockClear();
    mockPool.connect.mockClear();

    expect(await codeOf(appendSharedRow('tok', BLOCKED))).toBe('TOO_MANY_REQUESTS');
    expect(await codeOf(updateSharedRow('tok', 'ROW-1', CLEAN))).toBe('TOO_MANY_REQUESTS');

    expect({ hash: lua.hash(KEY), pttl: lua.pttl(KEY) }).toEqual(before);
    // A blocked title would file a report row: none was filed, so moderation never ran.
    expect(mockPool.query).not.toHaveBeenCalled();
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  // civitai/civitai-app-starters#597
  it('a create→withdraw loop is throttled to the refill rate, not locked out for a day', async () => {
    let landed = 0;
    let refusal: { message?: string } | undefined;
    for (let i = 0; i < 25 && !refusal; i++) {
      try {
        await appendSharedRow('tok', CLEAN);
        landed++;
        await withdrawSharedRow('tok', 'ROW-1');
      } catch (e) {
        refusal = e as { message?: string };
      }
    }
    expect(landed).toBe(10);
    expect(refusal?.message).toBe('Too many submissions — retry in 360s');
  });

  it('ten rejections lock further writes until one refills; the refused attempts are free', async () => {
    for (let i = 0; i < 10; i++) {
      expect(await codeOf(appendSharedRow('tok', BLOCKED))).toBe('BAD_REQUEST');
    }
    expect(budget()).toEqual([0, 0, 10 * REJECT_MS]);
    // Retrying during the lockout costs nothing, even a clean write.
    for (let i = 0; i < 3; i++) {
      expect(await codeOf(appendSharedRow('tok', CLEAN))).toBe('TOO_MANY_REQUESTS');
    }
    expect(budget()).toEqual([0, 0, 10 * REJECT_MS]);
    lua.nowMs = T0 + REJECT_MS;
    expect(await codeOf(appendSharedRow('tok', CLEAN))).toBe('OK');
  });
});

describe('SEAM: a write-budget refusal through the real tRPC handler', () => {
  const client = createTRPCClient<typeof appsSharedRouter>({
    links: [
      httpLink({
        url: 'http://localhost/api/trpc',
        transformer: clientTransformer,
        fetch: (input, init) =>
          fetchRequestHandler({
            endpoint: '/api/trpc',
            req: new Request(input as RequestInfo, init as RequestInit),
            router: appsSharedRouter,
            createContext: () =>
              ({
                acceptableOrigin: true,
                user: undefined,
                apiKeyId: null,
                tokenScope: TokenScope.Full,
                req: { headers: {} },
                res: { setHeader: () => undefined },
                cache: { edgeTTL: 0 },
                features: {},
                track: undefined,
              } as never),
          }),
      }),
    ],
  });

  it('data.rateLimit carries the wait derived from the binding bucket', async () => {
    for (let i = 0; i < 10; i++) await appendSharedRow('tok', CLEAN);
    // 137.4s after the burst drained: the next token is 222.6s away → 223s.
    lua.nowMs = T0 + 137_400;
    const NOW = Date.parse('2033-03-04T05:08:24.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);

    const err = await client.append.mutate({ blockToken: 'tok', value: CLEAN }).then(
      () => undefined,
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(TRPCClientError);
    const data = (err as TRPCClientError<typeof appsSharedRouter>).data as {
      code?: string;
      rateLimit?: unknown;
    };
    expect(data.code).toBe('TOO_MANY_REQUESTS');
    expect(data.rateLimit).toEqual({
      retryAfterSeconds: 223,
      retryAt: new Date(NOW + 223_000).toISOString(),
    });
    expect((err as Error).message).toBe('Too many submissions — retry in 223s');
  });
});
