import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClientModule from '~/server/flipt/client';

/**
 * Coverage for the App Blocks play-count counter surface added to
 * apps-shared.router: `incrementSharedCounter` (WRITE, min-trust gated),
 * `getTopSharedCounters` (READ), and `assertValidCounterKey`. Reuses the same
 * mock harness shape as apps-shared.router.test.ts (pg pool, block-token verifier,
 * flag, rate limiter, subject hydration) so every gate is pinned independently.
 *
 * The isolation guarantee (app A can't touch app B's counters) is asserted by
 * deriving the per-app schema from `claims.blockId` via the REAL apps-slug helper
 * and checking the emitted SQL targets exactly that schema.
 */

const {
  mockVerifyBlockToken,
  mockParseSubjectUserId,
  mockDbRead,
  mockIsSharedEnabled,
  mockPool,
  mockClient,
  mockGetSessionUser,
  mockCheckVoteRl,
  mockIsRevoked,
  mockIsFlipt,
  mockFindBlocked,
  mockChInsert,
  mockLog,
} = vi.hoisted(() => {
  // `pg`'s `query(sql, params)`, declared on the mock so an implementation can read its SQL (the
  // same source-level typing as apps-shared.router.test.ts).
  type QueryFn = (
    sql: string,
    params?: unknown[]
  ) => Promise<{ rows: unknown[]; rowCount: number }>;
  const mockClient = {
    query: vi.fn<QueryFn>(async () => ({ rows: [{ count: '3' }], rowCount: 1 })),
    release: vi.fn(),
  };
  const mockPool = {
    connect: vi.fn(async () => mockClient),
    query: vi.fn<QueryFn>(async () => ({ rows: [], rowCount: 0 })),
  };
  return {
    mockVerifyBlockToken: vi.fn(),
    mockParseSubjectUserId: vi.fn(),
    mockDbRead: { appBlock: { findUnique: vi.fn() }, account: { count: vi.fn(async () => 1) } },
    mockIsSharedEnabled: vi.fn(async () => true),
    mockPool,
    mockClient,
    mockGetSessionUser: vi.fn(),
    mockCheckVoteRl: vi.fn(async () => ({ allowed: true })),
    mockIsRevoked: vi.fn(async () => false),
    // Counter-key moderation: the per-app flags, the pure blocklist classifier, the hit sink.
    mockIsFlipt: vi.fn<(flag: string, entityId?: string, context?: unknown) => Promise<boolean>>(
      async () => false
    ),
    mockFindBlocked: vi.fn<(values: unknown, opts?: unknown) => Promise<unknown[]>>(async () => []),
    mockChInsert: vi.fn<(args: { table: string; values: unknown[] }) => Promise<void>>(
      async () => undefined
    ),
    mockLog: vi.fn<(payload: unknown, stream?: string) => Promise<void>>(async () => undefined),
  };
});

vi.mock('~/server/middleware/block-scope.middleware', () => ({
  verifyBlockToken: mockVerifyBlockToken,
  parseSubjectUserId: (...args: unknown[]) => mockParseSubjectUserId(...args),
}));
vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbRead }));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksSharedStorageEnabled: mockIsSharedEnabled,
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: (...a: unknown[]) => mockGetSessionUser(...a) },
}));
vi.mock('~/server/db/appsDb', () => ({ requireAppsDb: () => mockPool }));
vi.mock('~/server/utils/shared-storage-rate-limit', () => ({
  checkSharedAppendRateLimit: vi.fn(async () => ({ allowed: true })),
  checkSharedVoteRateLimit: (...a: unknown[]) => mockCheckVoteRl(...a),
}));
vi.mock('~/server/services/block-revocation.service', () => ({
  BlockRevocation: { isRevoked: (...a: unknown[]) => mockIsRevoked(...a) },
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: (payload: unknown, stream?: string) => mockLog(payload, stream),
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClientModule>()),
  isFlipt: (flag: string, entityId?: string, context?: unknown) =>
    mockIsFlipt(flag, entityId, context),
}));
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: { insert: (args: { table: string; values: unknown[] }) => mockChInsert(args) },
}));
// Cut the shared-content-safety → blocklist/prompt-audit → @civitai/db import
// chain (mirrors apps-shared.router.test.ts): the counter ops never touch the
// content-safety belt, and these mocks keep the module graph free of the
// workspace-package deps.
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(async () => undefined),
  throwOnBlockedUserContent: vi.fn(),
  findBlockedUserContent: (values: unknown, opts?: unknown) => mockFindBlocked(values, opts),
  stripBenignPhrases: async (text: string) => text,
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  auditPromptServer: vi.fn(async () => undefined),
}));

import {
  assertValidCounterKey,
  getTopSharedCounters,
  incrementSharedCounter,
} from '../apps-shared.router';
import { appSchemaIdent, sanitizeAppSlug } from '~/server/utils/apps-slug';
import { OnboardingSteps } from '~/server/common/enums';
import { isEscalatedServerFault } from '~/server/logging/server-fault-override';

const WRITE = 'apps:storage:shared:write';
const READ = 'apps:storage:shared:read';

function schemaFor(blockId: string): string {
  return appSchemaIdent(sanitizeAppSlug(blockId) as string);
}

function claims(blockId: string, scopes: string[]) {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: 'user:42',
    iat: 0,
    exp: 0,
    jti: 'j',
    blockId,
    appId: 'app_test',
    appBlockId: 'apb_test',
    blockInstanceId: 'bki_inst',
    ctx: {},
    scopes,
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

function allClientSql(): string {
  return mockClient.query.mock.calls.map((c) => String(c[0])).join('\n');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDbRead.appBlock.findUnique.mockResolvedValue({ id: 'apb_test', status: 'approved' });
  mockParseSubjectUserId.mockImplementation((sub: string) =>
    sub === 'anon' ? null : Number.parseInt(sub.slice('user:'.length), 10)
  );
  mockGetSessionUser.mockResolvedValue(trustedUser());
  mockIsSharedEnabled.mockResolvedValue(true);
  mockIsRevoked.mockResolvedValue(false);
  mockCheckVoteRl.mockResolvedValue({ allowed: true });
  mockClient.query.mockResolvedValue({ rows: [{ count: '3' }], rowCount: 1 });
  mockIsFlipt.mockResolvedValue(false);
  mockFindBlocked.mockResolvedValue([]);
});

describe('assertValidCounterKey', () => {
  it('accepts a bounded key', () => {
    expect(assertValidCounterKey('playcount:123')).toBe('playcount:123');
  });
  it('rejects empty / oversized / non-string keys', () => {
    expect(() => assertValidCounterKey('')).toThrow();
    expect(() => assertValidCounterKey('x'.repeat(65))).toThrow();
    expect(() => assertValidCounterKey(123 as unknown)).toThrow();
  });
});

describe('incrementSharedCounter', () => {
  it('happy path: a trusted subject increments → returns the new count', async () => {
    mockVerifyBlockToken.mockResolvedValue(claims('app-voting', [READ, WRITE]));
    const result = await incrementSharedCounter('tok', 'playcount:7');
    expect(result).toEqual({ key: 'playcount:7', count: 3 });
    // Targets THIS app's schema (isolation) — the counters + anchor writes.
    const sql = allClientSql();
    expect(sql).toContain(`${schemaFor('app-voting')}.counters`);
    expect(sql).toContain(`${schemaFor('app-voting')}.shared_kv`);
  });

  it('sub-trust caller (account too new) → FORBIDDEN (anti-inflation min-trust gate)', async () => {
    mockVerifyBlockToken.mockResolvedValue(claims('app-voting', [READ, WRITE]));
    mockGetSessionUser.mockResolvedValue(
      trustedUser({ createdAt: new Date() }) // < 7d old → fails the trust gate
    );
    await expect(incrementSharedCounter('tok', 'playcount:7')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // No counter write happened.
    expect(mockClient.query).not.toHaveBeenCalled();
  });

  it('missing the write scope → FORBIDDEN', async () => {
    mockVerifyBlockToken.mockResolvedValue(claims('app-voting', [READ]));
    await expect(incrementSharedCounter('tok', 'playcount:7')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('rate-limited → TOO_MANY_REQUESTS', async () => {
    mockVerifyBlockToken.mockResolvedValue(claims('app-voting', [READ, WRITE]));
    mockCheckVoteRl.mockResolvedValue({ allowed: false, retryAfterSeconds: 5 });
    await expect(incrementSharedCounter('tok', 'playcount:7')).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
  });

  it('CROSS-APP ISOLATION: app A and app B write to DIFFERENT schemas', async () => {
    mockVerifyBlockToken.mockResolvedValue(claims('app-a', [READ, WRITE]));
    await incrementSharedCounter('tokA', 'playcount:1');
    const sqlA = allClientSql();
    expect(sqlA).toContain(`${schemaFor('app-a')}.counters`);
    // App A's SQL must NEVER reference app B's schema.
    expect(sqlA).not.toContain(`${schemaFor('app-b')}.counters`);

    mockClient.query.mockClear();
    mockVerifyBlockToken.mockResolvedValue(claims('app-b', [READ, WRITE]));
    await incrementSharedCounter('tokB', 'playcount:1');
    const sqlB = allClientSql();
    expect(sqlB).toContain(`${schemaFor('app-b')}.counters`);
    expect(sqlB).not.toContain(`${schemaFor('app-a')}.counters`);
    // The two apps resolve to distinct schemas.
    expect(schemaFor('app-a')).not.toBe(schemaFor('app-b'));
  });
});

describe('getTopSharedCounters', () => {
  it('returns top-N [{key,count}] and issues a count-DESC + prefix + limit query on THIS app schema', async () => {
    mockVerifyBlockToken.mockResolvedValue(claims('app-voting', [READ]));
    mockPool.query.mockResolvedValue({
      rows: [
        { key: 'playcount:9', count: '42' },
        { key: 'playcount:3', count: '7' },
      ],
      rowCount: 2,
    });
    const items = await getTopSharedCounters('tok', 'playcount:', 10);
    expect(items).toEqual([
      { key: 'playcount:9', count: 42 },
      { key: 'playcount:3', count: 7 },
    ]);
    const sql = String(mockPool.query.mock.calls[0][0]);
    const params = mockPool.query.mock.calls[0][1] as unknown[];
    expect(sql).toContain(`${schemaFor('app-voting')}.counters`);
    expect(sql).toContain('ORDER BY c.count DESC');
    expect(sql).toContain('LIKE $1');
    expect(sql).toContain('LIMIT $2');
    // Prefix is escaped + wildcarded; limit is passed through.
    expect(params[0]).toBe('playcount:%');
    expect(params[1]).toBe(10);
  });

  it('anon READ is allowed by the resolver (no subject required for top)', async () => {
    mockVerifyBlockToken.mockResolvedValue(claims('app-voting', [READ]));
    mockParseSubjectUserId.mockReturnValue(null); // anon
    mockGetSessionUser.mockResolvedValue(null);
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const items = await getTopSharedCounters('tok', '', 20);
    expect(items).toEqual([]);
  });
});

// ── Counter-key local moderation ──────────────────────────────────────────────
// The key is app-chosen text `getTop` returns to every reader. Same two per-app flags as `data`.
describe('incrementSharedCounter — counter-key moderation', () => {
  const SHADOW_FLAG = 'app-blocks-shared-data-moderation';
  const ENFORCE_FLAG = 'app-blocks-shared-data-moderation-enforce';
  const BAD_KEY = 'playcount:13 year old girl';

  function setFlags({ shadow = false, enforce = false }: { shadow?: boolean; enforce?: boolean }) {
    mockIsFlipt.mockImplementation(async (flag: string) =>
      flag === SHADOW_FLAG ? shadow : flag === ENFORCE_FLAG ? enforce : false
    );
  }
  function reportReasons(): string[] {
    return mockPool.query.mock.calls
      .filter((c) => String(c[0]).includes('shared_kv_reports'))
      .map((c) => String((c[1] as unknown[])[3]));
  }
  // A refused increment may have opened the transaction (the creating INSERT decides whether the
  // key is scanned), but it must leave nothing behind: no counter row, no COMMIT, a ROLLBACK.
  function expectNoCounterWrite() {
    const sql = mockClient.query.mock.calls.map((c) => String(c[0]));
    expect(sql.some((q) => q.includes('.counters'))).toBe(false);
    expect(sql).not.toContain('COMMIT');
    expect(sql).toContain('ROLLBACK');
  }
  const scanEvents = () =>
    mockLog.mock.calls.filter(
      (c) => (c[0] as { name?: string }).name === 'app-blocks-shared-data-moderation-scan'
    );
  const flushImmediates = async () => {
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
  };

  beforeEach(() => {
    mockVerifyBlockToken.mockResolvedValue(claims('app-voting', [READ, WRITE]));
    // `clearAllMocks` keeps implementations, so cases below that override these must not leak.
    mockPool.query.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    mockClient.query.mockImplementation(async () => ({ rows: [{ count: '3' }], rowCount: 1 }));
  });

  it('INVARIANT GUARD: both flags OFF → a flagged key increments exactly as before, nothing scanned', async () => {
    await expect(incrementSharedCounter('tok', BAD_KEY)).resolves.toEqual({
      key: BAD_KEY,
      count: 3,
    });
    await flushImmediates();
    expect(mockFindBlocked).not.toHaveBeenCalled();
    expect(mockChInsert).not.toHaveBeenCalled();
    expect(mockIsFlipt).toHaveBeenCalledWith(ENFORCE_FLAG, 'apb_test', undefined);
  });

  it('🔴 REGRESSION (enforce): a flagged counter key → BAD_REQUEST, no counter write, Report filed', async () => {
    setFlags({ enforce: true });
    await expect(incrementSharedCounter('tok', BAD_KEY)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Content flagged for review',
    });
    expectNoCounterWrite();
    expect(reportReasons()).toEqual(['auto:counterKey:minor']);
  });

  it('🔴 REGRESSION (enforce): a format-character-split key is caught', async () => {
    setFlags({ enforce: true });
    await expect(incrementSharedCounter('tok', 'playcount:lo\u200Bli')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expectNoCounterWrite();
  });

  it('enforce: a clean key increments, and the blocklist saw the key as ONE array entry', async () => {
    setFlags({ enforce: true });
    await expect(incrementSharedCounter('tok', 'playcount:7')).resolves.toEqual({
      key: 'playcount:7',
      count: 3,
    });
    expect(mockFindBlocked).toHaveBeenCalledTimes(1);
    expect(mockFindBlocked.mock.calls[0][0]).toEqual(['playcount:7']);
  });

  it('enforce: a blocklist outage is a clean 4xx with no counter write', async () => {
    setFlags({ enforce: true });
    mockFindBlocked.mockRejectedValue(new Error('redis down'));
    const error = await incrementSharedCounter('tok', 'playcount:7').catch((e: unknown) => e);
    // Escalated: a 4xx to the caller, logged at server-fault severity.
    expect(isEscalatedServerFault(error)).toBe(true);
    await expect(Promise.reject(error)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Content could not be reviewed right now. Please try again.',
    });
    expectNoCounterWrite();
  });

  // The anchor INSERT conflicts: the key already exists, so this increment does not create it.
  function existingKey() {
    mockClient.query.mockImplementation(async (sql: string) =>
      String(sql).includes('INTO "app_app_voting".shared_kv')
        ? { rows: [], rowCount: 0 }
        : { rows: [{ count: '3' }], rowCount: 1 }
    );
  }

  it('🔴 enforce: an increment of an EXISTING key is NOT scanned — keys are checked at creation only', async () => {
    // Pre-existing keys are covered by the offline replay before the enforce flip, not here.
    setFlags({ enforce: true });
    existingKey();
    await expect(incrementSharedCounter('tok', BAD_KEY)).resolves.toEqual({
      key: BAD_KEY,
      count: 3,
    });
    await flushImmediates();
    expect(mockFindBlocked).not.toHaveBeenCalled();
    expect(scanEvents()).toEqual([]);
    expect(reportReasons()).toEqual([]);
    expect(allClientSql()).toContain('COMMIT');
  });

  it('enforce: a creating increment is rolled back, scanned with NO transaction open, then written', async () => {
    // The anchor INSERT takes the app's quota-row lock; a blocklist read must not hold it.
    setFlags({ enforce: true });
    const order: string[] = [];
    mockClient.query.mockImplementation(async (sql: string) => {
      order.push(String(sql).includes('.counters') ? 'counters' : String(sql).split(/\s/)[0]);
      return { rows: [{ count: '3' }], rowCount: 1 };
    });
    mockFindBlocked.mockImplementation(async () => {
      order.push('scan');
      return [];
    });
    await incrementSharedCounter('tok', 'playcount:7');
    expect(order).toEqual([
      'BEGIN',
      'SET',
      'INSERT',
      'ROLLBACK',
      'scan',
      'BEGIN',
      'SET',
      'INSERT',
      'counters',
      'COMMIT',
    ]);
  });

  it('enforce: a NEW flagged key files the Report and legal alert against its writer', async () => {
    setFlags({ enforce: true });
    await expect(incrementSharedCounter('tok', BAD_KEY)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    // [id, key, reporter, reason]: the caller, no key (the key was rolled back and never existed).
    const reportRows = mockPool.query.mock.calls
      .filter((c) => String(c[0]).includes('shared_kv_reports'))
      .map((c) => c[1] as unknown[]);
    expect(reportRows).toEqual([[expect.any(String), null, 42, 'auto:counterKey:minor']]);
    expect(
      mockLog.mock.calls.some(
        (c) => (c[0] as { name?: string }).name === 'app-blocks-shared-storage-legal-block'
      )
    ).toBe(true);
  });

  it('🔴 REGRESSION (enforce): the refused key is recorded WITHOUT its text — in no column at all', async () => {
    setFlags({ enforce: true });
    await expect(incrementSharedCounter('tok', BAD_KEY)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await vi.waitFor(() => expect(mockChInsert).toHaveBeenCalled());
    const rows = mockChInsert.mock.calls[0][0].values as Array<Record<string, unknown>>;
    expect(rows).toContainEqual(
      expect.objectContaining({
        rowKey: '',
        rowKeySha256: createHash('sha256').update(BAD_KEY).digest('hex'),
        surface: 'counter',
        mode: 'enforce',
        blocked: 1,
        category: 'minor',
        leafKind: 'key',
        leafText: '',
      })
    );
    const carrying = rows.flatMap((r) =>
      Object.entries(r).flatMap(([column, v]) =>
        typeof v === 'string' && (v.includes(BAD_KEY) || v.includes('playcount')) ? [column] : []
      )
    );
    expect(carrying).toEqual([]);
  });

  it('both flags on behave as ENFORCE: a flagged key is refused, and scanned once', async () => {
    setFlags({ shadow: true, enforce: true });
    await expect(incrementSharedCounter('tok', BAD_KEY)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await flushImmediates();
    expect(mockFindBlocked).toHaveBeenCalledTimes(1);
  });

  it('both flags on: a new clean key is scanned ONCE (inline), never again after the commit', async () => {
    setFlags({ shadow: true, enforce: true });
    await expect(incrementSharedCounter('tok', 'playcount:7')).resolves.toEqual({
      key: 'playcount:7',
      count: 3,
    });
    await flushImmediates();
    expect(mockFindBlocked).toHaveBeenCalledTimes(1);
    expect(scanEvents()).toHaveLength(1);
  });

  it('SEAM: the subject’s moderator bit reaches the blocklist for a counter key', async () => {
    setFlags({ enforce: true });
    mockGetSessionUser.mockResolvedValue(trustedUser({ isModerator: true }));
    await incrementSharedCounter('tok', 'playcount:7');
    expect(mockFindBlocked.mock.calls[0][1]).toEqual({ exemptFromPatterns: true });
  });

  it('shadow: an increment of an EXISTING key (anchor INSERT inserted nothing) is not scanned', async () => {
    setFlags({ shadow: true });
    existingKey();
    await expect(incrementSharedCounter('tok', BAD_KEY)).resolves.toEqual({
      key: BAD_KEY,
      count: 3,
    });
    await flushImmediates();
    expect(mockFindBlocked).not.toHaveBeenCalled();
  });

  it('INVARIANT GUARD (shadow): the increment returns while the key scan is still pending', async () => {
    setFlags({ shadow: true });
    mockFindBlocked.mockImplementation(() => new Promise(() => undefined));
    let scanCallsWhenSettled = -1;
    const out = await incrementSharedCounter('tok', 'playcount:7').then((r) => {
      scanCallsWhenSettled = mockFindBlocked.mock.calls.length;
      return r;
    });
    expect(out).toEqual({ key: 'playcount:7', count: 3 });
    expect(scanCallsWhenSettled).toBe(0);
    await flushImmediates();
    expect(mockFindBlocked).toHaveBeenCalledTimes(1);
  });

  it('shadow: a failed COMMIT is never scanned', async () => {
    setFlags({ shadow: true });
    mockClient.query.mockImplementation(async (sql: string) => {
      if (String(sql) === 'COMMIT') throw new Error('serialization failure');
      return { rows: [{ count: '3' }], rowCount: 1 };
    });
    await expect(incrementSharedCounter('tok', BAD_KEY)).rejects.toThrow('serialization failure');
    await flushImmediates();
    expect(mockFindBlocked).not.toHaveBeenCalled();
  });

  it('🔴 REGRESSION (shadow): a flagged key increments AND is recorded against the key, no Report', async () => {
    setFlags({ shadow: true });
    await expect(incrementSharedCounter('tok', BAD_KEY)).resolves.toEqual({
      key: BAD_KEY,
      count: 3,
    });
    await vi.waitFor(() => expect(mockChInsert).toHaveBeenCalled());
    expect(mockChInsert.mock.calls[0][0].values).toContainEqual(
      expect.objectContaining({
        rowKey: BAD_KEY,
        surface: 'counter',
        mode: 'shadow',
        category: 'minor',
        leafKind: 'key',
      })
    );
    expect(reportReasons()).toEqual([]);
    expect(
      mockLog.mock.calls.some(
        (c) => (c[0] as { name?: string }).name === 'app-blocks-shared-storage-legal-block'
      )
    ).toBe(false);
  });
});
