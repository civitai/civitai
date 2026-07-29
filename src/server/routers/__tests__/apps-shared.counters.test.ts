import { beforeEach, describe, expect, it, vi } from 'vitest';

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
} = vi.hoisted(() => {
  const mockClient = {
    query: vi.fn(async () => ({ rows: [{ count: '3' }], rowCount: 1 })),
    release: vi.fn(),
  };
  const mockPool = {
    connect: vi.fn(async () => mockClient),
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
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
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn(async () => undefined) }));
// Cut the shared-content-safety → blocklist/prompt-audit → @civitai/db import
// chain (mirrors apps-shared.router.test.ts): the counter ops never touch the
// content-safety belt, and these mocks keep the module graph free of the
// workspace-package deps.
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(async () => undefined),
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
