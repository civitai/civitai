import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { TRPCError } from '@trpc/server';
import { createTRPCClient, httpLink, TRPCClientError } from '@trpc/client';
import type * as FliptClientModule from '~/server/flipt/client';
import type * as RateLimitModule from '~/server/utils/shared-storage-rate-limit';
import { dbMock, redisMock, resetSharedMocks } from '~/__tests__/mocks';
import { REDIS_KEYS } from '~/server/redis/client';
import type { CombinedDataTransformer } from '@trpc/server';
import {
  clientTransformer,
  unionDeserialize,
  writeSerialize,
} from '~/shared/utils/trpc-union-transformer';
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
  mockThrowOnBlocked,
  mockGetBlocklistData,
  mockAudit,
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
    mockThrowOnBlocked: vi.fn<
      (content: unknown, options: { onBlocked?: (kind: string) => never }) => Promise<void>
    >(async () => undefined),
    // The list read the content-safety belt does BEFORE the guard (no caller input).
    mockGetBlocklistData: vi.fn<(type: string) => Promise<string[]>>(async () => []),
    // The external moderation call — counted to measure how many runs a caller can buy.
    mockAudit: vi.fn<() => Promise<void>>(async () => undefined),
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
  throwOnBlockedUserContent: (content: unknown, options: { onBlocked?: (kind: string) => never }) =>
    mockThrowOnBlocked(content, options),
  getBlocklistData: (type: string) => mockGetBlocklistData(type),
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
  auditPromptServer: () => mockAudit(),
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
  measureSharedValue,
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
  mockThrowOnBlocked.mockResolvedValue(undefined);
  mockGetBlocklistData.mockResolvedValue([]);
  mockAudit.mockResolvedValue(undefined);
  mockWritePath({});
});

afterEach(() => {
  expect(lua.errors).toEqual([]);
  vi.useRealTimers();
});

/** Whether a serialized value holds a NUL in any key or string (decoded, not pattern-matched). */
function holdsNul(serialized: string) {
  let found = false;
  JSON.parse(serialized, (key, value: unknown) => {
    if (key.includes('\0') || (typeof value === 'string' && value.includes('\0'))) found = true;
    return value;
  });
  return found;
}

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
  mockPool.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('count(*)')) return { rows: [{ n: String(userRows) }], rowCount: 1 };
    // The stored-size probe's `$2::jsonb` cast, as Postgres answers a NUL (measured: 22P05).
    if (sql.includes('.quota') && holdsNul(String(params?.[1])))
      throw Object.assign(new Error('unsupported Unicode escape sequence'), { code: '22P05' });
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

  it('a 5xx TRPCError that is not marked as our fault is charged like any refusal', async () => {
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql.trim().startsWith('INSERT INTO')) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'insert failed' });
      }
      return { rows: [], rowCount: 0 };
    });
    expect(await codeOf(appendSharedRow('tok', CLEAN))).toBe('INTERNAL_SERVER_ERROR');
    expect(budget()).toEqual([0, 0, REJECT_MS]);
  });

  it('an unknown plain Error thrown after the reserve is charged, not refunded', async () => {
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql.trim().startsWith('INSERT INTO')) throw new Error('something unexpected');
      return { rows: [], rowCount: 0 };
    });
    await expect(appendSharedRow('tok', CLEAN)).rejects.toThrow('something unexpected');
    expect(budget()).toEqual([0, 0, REJECT_MS]);
  });

  it('an update whose UPDATE statement throws a plain Error is charged', async () => {
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql.trim().startsWith('UPDATE')) throw new Error('something unexpected');
      return { rows: [], rowCount: 0 };
    });
    await expect(updateSharedRow('tok', 'ROW-1', CLEAN)).rejects.toThrow('something unexpected');
    expect(budget()).toEqual([0, 0, REJECT_MS]);
  });

  it.each(['BEGIN', 'SET LOCAL', 'COMMIT'])(
    'a failed %s (transaction plumbing) refunds free on both append and update',
    async (statement) => {
      mockClient.query.mockImplementation(async (sql: string) => {
        if (sql.startsWith(statement)) throw new Error('connection reset');
        if (sql.trim().startsWith('UPDATE')) return { rows: [], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      });
      await expect(appendSharedRow('tok', CLEAN)).rejects.toThrow('connection reset');
      await expect(updateSharedRow('tok', 'ROW-1', CLEAN)).rejects.toThrow('connection reset');
      expect(budget()).toEqual([0, 0, 0]);
    }
  );

  it('failing to acquire a connection refunds free', async () => {
    mockPool.connect.mockRejectedValueOnce(new Error('pool exhausted'));
    mockPool.connect.mockRejectedValueOnce(new Error('pool exhausted'));
    await expect(appendSharedRow('tok', CLEAN)).rejects.toThrow('pool exhausted');
    await expect(updateSharedRow('tok', 'ROW-1', CLEAN)).rejects.toThrow('pool exhausted');
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

  it('the title/body blocklist read failing is refunded free, with a retry message', async () => {
    mockGetBlocklistData.mockRejectedValue(new Error('redis unreachable'));
    await expect(appendSharedRow('tok', CLEAN)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Content could not be reviewed right now. Please try again.',
    });
    await expect(updateSharedRow('tok', 'ROW-1', CLEAN)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(budget()).toEqual([0, 0, 0]);
  });

  // The lists read fine, then the guard itself throws on the caller's text — the shape of a scan
  // bug a crafted input could trigger. Escalating that would make every such write a free
  // moderation call, so it is refused AND charged, one rejection per write.
  it('a non-block throw from the title/body scan is refused and charged, not refunded', async () => {
    mockThrowOnBlocked.mockRejectedValue(new TypeError('Invalid URL'));
    await expect(appendSharedRow('tok', CLEAN)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Content could not be reviewed right now. Please try again.',
    });
    expect(budget()).toEqual([0, 0, REJECT_MS]);
  });

  it('a real blocked link in the title is still charged a rejection', async () => {
    mockThrowOnBlocked.mockImplementation(async (_content, options) => {
      options.onBlocked?.('link');
    });
    await expect(appendSharedRow('tok', CLEAN)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Content contains a blocked link',
    });
    expect(budget()).toEqual([0, 0, REJECT_MS]);
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

/** The real tRPC handler, so input validation runs exactly as it does for a caller. */
const clientWith = (transformer: CombinedDataTransformer) =>
  createTRPCClient<typeof appsSharedRouter>({
    links: [
      httpLink({
        url: 'http://localhost/api/trpc',
        transformer,
        fetch: (input, init) => {
          return fetchRequestHandler({
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
          });
        },
      }),
    ],
  });
const client = clientWith(clientTransformer);
/** A client that writes its input with devalue; the server's transformer reads either format. */
const devalueClient = clientWith({
  input: { serialize: writeSerialize, deserialize: unionDeserialize },
  output: clientTransformer.output,
});

/** A tRPC client call's outcome: 'OK' or the error code the client received. */
async function trpcCodeOf(p: Promise<unknown>) {
  return p.then(
    () => 'OK',
    (e: unknown) => (e as TRPCClientError<typeof appsSharedRouter>).data?.code ?? 'UNKNOWN'
  );
}

describe('write budget: values Postgres cannot store', () => {
  const NUL_DATA = { ...CLEAN, data: { nested: [{ note: 'a\u0000b' }] } };

  it('200 NUL appends over tRPC are refused 400 before the budget or moderation', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 200; i++) {
      codes.add(await trpcCodeOf(client.append.mutate({ blockToken: 'tok', value: NUL_DATA })));
    }
    expect([...codes]).toEqual(['BAD_REQUEST']);
    expect(mockAudit).not.toHaveBeenCalled();
    expect(lua.hash(KEY)).toBeUndefined();
  });

  it('the refusal names the problem and covers object keys and the title', async () => {
    const values = [
      { ...CLEAN, data: { ['k\u0000']: 1 } },
      { title: 'nul \u0000 in title' },
      { ...CLEAN, body: 'nul \u0000 in body' },
    ];
    for (const value of values) {
      const err = await client.append.mutate({ blockToken: 'tok', value }).then(
        () => undefined,
        (e: unknown) => e as TRPCClientError<typeof appsSharedRouter>
      );
      expect(err?.data?.code).toBe('BAD_REQUEST');
      expect(err?.message).toContain('value contains a NUL character or an unpaired surrogate');
    }
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('an unpaired surrogate is refused too; a paired one and a spelled-out \\u0000 are not', async () => {
    // The last two follow a literal backslash (an odd run), so the escape is still a real one.
    for (const s of ['a\ud800b', 'a\udc00', '\udfff', 'a\\\u0000', '\\\ud800']) {
      expect(
        await trpcCodeOf(
          client.append.mutate({ blockToken: 'tok', value: { ...CLEAN, data: { s } } })
        )
      ).toBe('BAD_REQUEST');
    }
    expect(mockAudit).not.toHaveBeenCalled();
    for (const s of ['\ud83d\ude00', '\\u0000', '\\\\u0000']) {
      expect(
        await trpcCodeOf(
          client.append.mutate({ blockToken: 'tok', value: { ...CLEAN, data: { s } } })
        )
      ).toBe('OK');
    }
    // Positive control for the `not.toHaveBeenCalled()` checks in this block.
    expect(mockAudit).toHaveBeenCalledTimes(3);
  });

  it('called directly, a NUL after a literal backslash is refused before moderation', async () => {
    expect(await codeOf(appendSharedRow('tok', { ...CLEAN, data: { s: 'a\\\u0000' } }))).toBe(
      'BAD_REQUEST'
    );
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('a plain error from the stored-size probe itself is charged on append and update', async () => {
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('.quota')) throw new Error('probe failed');
      if (sql.includes('count(*)')) return { rows: [{ n: '0' }], rowCount: 1 };
      if (sql.includes('author_user_id, size_bytes'))
        return { rows: [{ author_user_id: 42, size_bytes: 89 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    await expect(appendSharedRow('tok', CLEAN)).rejects.toThrow('probe failed');
    await expect(updateSharedRow('tok', 'ROW-1', CLEAN)).rejects.toThrow('probe failed');
    expect(budget()).toEqual([0, 0, 2 * REJECT_MS]);
  });

  it('update over tRPC refuses a NUL the same way', async () => {
    expect(
      await trpcCodeOf(client.update.mutate({ blockToken: 'tok', key: 'ROW-1', value: NUL_DATA }))
    ).toBe('BAD_REQUEST');
    expect(mockAudit).not.toHaveBeenCalled();
  });

  // A caller that skips the schema (the functions are exported) still meets the router's own copy
  // of the check, before moderation; the refusal is charged like any other.
  it('called directly, 200 NUL appends cost no moderation and are refused within the rejection capacity', async () => {
    const codes: string[] = [];
    for (let i = 0; i < 200; i++) codes.push(await codeOf(appendSharedRow('tok', NUL_DATA)));
    expect(codes.slice(0, 10)).toEqual(Array(10).fill('BAD_REQUEST'));
    expect(new Set(codes.slice(10))).toEqual(new Set(['TOO_MANY_REQUESTS']));
    expect(mockAudit).not.toHaveBeenCalled();
    expect(budget()).toEqual([0, 0, 10 * REJECT_MS]);
  });

  it('called directly, a NUL update is refused before moderation and charged', async () => {
    expect(await codeOf(updateSharedRow('tok', 'ROW-1', NUL_DATA))).toBe('BAD_REQUEST');
    expect(mockAudit).not.toHaveBeenCalled();
    expect(budget()).toEqual([0, 0, REJECT_MS]);
  });
});

describe('SEAM: a write-budget refusal through the real tRPC handler', () => {
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

describe('shared value size cap: checked before the value is scanned or serialized', () => {
  const CAP = 64 * 1024;
  const OVER_CAP = { code: 'PAYLOAD_TOO_LARGE', message: 'value exceeds size cap' };
  const UNSTORABLE = 'value contains a NUL character or an unpaired surrogate';
  // The checks this replaced, on the string JSON.stringify writes.
  const stringifiedVerdict = (value: unknown) => {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, 'utf8') > CAP) return 'over-cap';
    return /(?<!\\)(?:\\\\)*\\u(?:0000|d[89a-f][0-9a-f]{2})/.test(serialized) ? 'unstorable' : 'ok';
  };

  /**
   * A value whose JSON is exactly `bytes` UTF-8 bytes. Its multi-byte text makes that 10,000 more
   * than its length in UTF-16 units, so a measure in the wrong unit lands on the wrong side.
   */
  function valueOfBytes(bytes: number) {
    const base = { title: CLEAN.title, data: { text: 'é日😀'.repeat(2_000), pad: '' } };
    const pad = bytes - Buffer.byteLength(JSON.stringify(base), 'utf8');
    return { ...base, data: { ...base.data, pad: 'x'.repeat(pad) } };
  }

  async function trpcErrorOf(p: Promise<unknown>) {
    const err = await p.then(
      () => undefined,
      (e: unknown) => e as TRPCClientError<typeof appsSharedRouter>
    );
    return err && { code: err.data?.code, message: err.message };
  }

  it('at cap - 1 and cap a value is stored; at cap + 1 it is refused with the size error', async () => {
    const verdicts: string[] = [];
    for (const bytes of [CAP - 1, CAP, CAP + 1]) {
      const value = valueOfBytes(bytes);
      expect(Buffer.byteLength(JSON.stringify(value), 'utf8')).toBe(bytes);
      expect(bytes - JSON.stringify(value).length).toBe(10_000);
      expect(measureSharedValue(value)).toBe(stringifiedVerdict(value));
      verdicts.push(measureSharedValue(value));
    }
    expect(verdicts).toEqual(['ok', 'ok', 'over-cap']);

    await expect(appendSharedRow('tok', valueOfBytes(CAP))).resolves.toMatchObject({
      key: expect.any(String),
    });
    await expect(appendSharedRow('tok', valueOfBytes(CAP + 1))).rejects.toMatchObject(OVER_CAP);
    await expect(updateSharedRow('tok', 'ROW-1', valueOfBytes(CAP + 1))).rejects.toMatchObject(
      OVER_CAP
    );
    expect(
      await trpcErrorOf(client.append.mutate({ blockToken: 'tok', value: valueOfBytes(CAP + 1) }))
    ).toEqual(OVER_CAP);
    expect(
      await trpcErrorOf(client.append.mutate({ blockToken: 'tok', value: valueOfBytes(CAP) }))
    ).toBeUndefined();
  });

  it('gives the verdict the stringified checks gave for text Postgres cannot store', async () => {
    const corpus: [unknown, string][] = [
      [{ title: 'nul \u0000 in title' }, 'unstorable'],
      [{ title: 't', body: 'lone \ud800 in body' }, 'unstorable'],
      [{ title: 't', data: { ['\udfff']: 1 } }, 'unstorable'],
      [{ title: 't', data: [{ s: 'a\\\u0000' }] }, 'unstorable'],
      [{ title: '😀 paired', body: '日本語 héllo', data: { s: '\\u0000' } }, 'ok'],
      [{ title: 't', data: { s: '\u0001\u001f' } }, 'ok'],
    ];
    for (const [value, expected] of corpus) {
      expect(measureSharedValue(value)).toBe(expected);
      expect(stringifiedVerdict(value)).toBe(expected);
    }
    expect(
      await trpcErrorOf(
        client.append.mutate({ blockToken: 'tok', value: { title: 't', data: { s: 'a\ud800' } } })
      )
    ).toEqual({ code: 'BAD_REQUEST', message: expect.stringContaining(UNSTORABLE) });
  });

  it('refuses a value over the cap with the size error even when it also holds a NUL', async () => {
    const value = { title: 'nul \u0000 first', data: 'x'.repeat(CAP) };
    expect(measureSharedValue(value)).toBe('over-cap');
    await expect(appendSharedRow('tok', value)).rejects.toMatchObject(OVER_CAP);
    expect(await trpcErrorOf(client.append.mutate({ blockToken: 'tok', value }))).toEqual(OVER_CAP);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  describe('a value whose JSON is far over the cap', () => {
    const ITEMS = 20_000;
    // 5,000 rather than a divisor of the cap, so no chunk ends exactly on it.
    const chunk = { s: 'x'.repeat(5_000) };
    const farOver = () => ({ title: CLEAN.title, data: new Array(ITEMS).fill(chunk) });

    it('stops scanning once the measure passes the cap', () => {
      const meter = { visits: 0, chars: 0, scanned: 0 };
      expect(measureSharedValue(farOver(), meter)).toBe('over-cap');
      expect(meter.scanned).toBeLessThanOrEqual(CAP);
      // The array's items are charged when it opens; only the ~13 chunks inside the cap are opened.
      expect(meter.visits).toBeLessThan(ITEMS + 100);
    });

    it('is refused over tRPC with the size error, without serializing it or running moderation', async () => {
      // Every character JSON.stringify writes during the call, whatever it is called on.
      const stringify = JSON.stringify;
      let stringified = 0;
      const spy = vi
        .spyOn(JSON, 'stringify')
        .mockImplementation((...args: Parameters<typeof stringify>) => {
          const out = stringify(...args);
          stringified += out?.length ?? 0;
          return out;
        });
      let err;
      try {
        err = await trpcErrorOf(
          devalueClient.append.mutate({ blockToken: 'tok', value: farOver() })
        );
      } finally {
        spy.mockRestore();
      }

      expect(err).toEqual(OVER_CAP);
      // The request body and the error response; the value itself is never written out.
      expect(stringified).toBeLessThan(400_000);
      expect(mockAudit).not.toHaveBeenCalled();
    });
  });

  it('refuses a value with more entries than fit in the cap, with the size error', async () => {
    // Every value JSON.stringify writes costs at least two bytes, so ~32,000 written values fit
    // and more entries than that are refused even when they are left out of the JSON.
    const numbers = { title: CLEAN.title, data: new Array(32_000).fill(0) };
    expect(Buffer.byteLength(JSON.stringify(numbers), 'utf8')).toBeLessThanOrEqual(CAP);
    expect(measureSharedValue(numbers)).toBe('ok');
    const omitted = {
      title: CLEAN.title,
      data: Object.fromEntries(Array.from({ length: 40_000 }, (_, i) => [`k${i}`, undefined])),
    };
    expect(JSON.stringify(omitted).length).toBeLessThan(100);
    expect(measureSharedValue(omitted)).toBe('over-cap');
    await expect(appendSharedRow('tok', omitted)).rejects.toMatchObject(OVER_CAP);
  });

  it('refuses a value JSON.stringify cannot write before moderation runs', async () => {
    const value = { title: CLEAN.title, data: { n: BigInt(1) } };
    expect(measureSharedValue(value)).toBe('unserializable');
    await expect(appendSharedRow('tok', value)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'value is not serializable',
    });
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
