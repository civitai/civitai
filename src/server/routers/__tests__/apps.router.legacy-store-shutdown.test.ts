import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import type * as FliptClientModule from '~/server/flipt/client';

/**
 * The legacy-store shutdown on the bridge: with `app-blocks-legacy-stores-removed` on, every
 * `apps.storage.*` and `apps.shared.*` procedure (what useAppStorage / useSharedStorage reach
 * through the hosts) refuses with PRECONDITION_FAILED and the stable code before the block token
 * is even verified. Off, or when the flag eval fails, each procedure reaches token verification
 * as before.
 */

const FLAG = 'app-blocks-legacy-stores-removed';
const GUIDE = 'https://developer.civitai.com/apps/guide/storage#moving-from-the-legacy-stores';

const { mockIsFlipt, mockVerifyBlockToken, mockPool, mockDbRead } = vi.hoisted(() => {
  type QueryFn = (
    sql: string,
    params?: unknown[]
  ) => Promise<{ rows: unknown[]; rowCount: number }>;
  const client = {
    query: vi.fn<QueryFn>(async () => ({ rows: [], rowCount: 0 })),
    release: vi.fn(),
  };
  return {
    mockIsFlipt: vi.fn<(flag: string, entityId?: string, context?: unknown) => Promise<boolean>>(),
    mockVerifyBlockToken: vi.fn<(token: string) => Promise<unknown>>(async () => null),
    mockPool: {
      connect: vi.fn(async () => client),
      query: vi.fn<QueryFn>(async () => ({ rows: [], rowCount: 0 })),
    },
    mockDbRead: { appBlock: { findUnique: vi.fn() }, account: { count: vi.fn() } },
  };
});

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClientModule>()),
  isFlipt: (flag: string, entityId?: string, context?: unknown) =>
    mockIsFlipt(flag, entityId, context),
  getFliptBoolean: async () => false,
}));
vi.mock('~/server/middleware/block-scope.middleware', () => ({
  verifyBlockToken: (token: string) => mockVerifyBlockToken(token),
  parseSubjectUserId: () => null,
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: async () => true,
  isAppBlocksAuthorEnabled: async () => true,
  isAppBlocksSharedStorageEnabled: async () => true,
}));
vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbRead }));
vi.mock('~/server/db/appsDb', () => ({ requireAppsDb: () => mockPool }));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: async () => null },
}));
vi.mock('~/server/services/apps/storage-provision.service', () => ({
  AppStorageProvisioner: {
    getQuota: vi.fn(),
    getUserQuota: vi.fn(),
    provisionReviewPreview: vi.fn(),
  },
}));
vi.mock('~/server/services/block-revocation.service', () => ({
  BlockRevocation: { isRevoked: async () => false },
}));
vi.mock('~/server/services/blocks/user-app-surface.service', () => ({
  recordScopeInvocation: async () => undefined,
}));
vi.mock('~/server/services/user.service', () => ({ getUserById: vi.fn() }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: async () => undefined }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { insert: async () => undefined } }));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedUserContent: async () => undefined,
  getBlocklistData: async () => [],
  findBlockedUserContent: async () => [],
  stripBenignPhrases: async (text: string) => text,
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  auditPromptServer: async () => undefined,
}));
vi.mock('~/server/services/blocks/app-sub-listing.service', () => ({
  syncSubListingForSharedRow: async () => undefined,
}));
vi.mock('~/server/utils/shared-storage-rate-limit', () => ({
  reserveSharedWrite: async () => ({ allowed: true, release: async () => undefined }),
  checkSharedVoteRateLimit: async () => ({ allowed: true }),
  checkSharedReportRateLimit: async () => ({ allowed: true }),
  checkSharedWithdrawRateLimit: async () => ({ allowed: true }),
}));

import { appsRouter, appsStorageRouter } from '../apps.router';
import { appsSharedRouter } from '../apps-shared.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const TOKEN = 'tok_legacy';
const KEY = '01JQ8KZ3M4N5P6Q7R8S9T0V1W2';

function fakeCtx() {
  return {
    acceptableOrigin: true,
    user: { id: 29, isModerator: false },
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  };
}

type Caller = ReturnType<typeof appsRouter.createCaller>;
type Case = { store: 'app' | 'shared'; name: string; call: (c: Caller) => Promise<unknown> };

const CASES: Case[] = [
  { store: 'app', name: 'get', call: (c) => c.storage.get({ blockToken: TOKEN, key: 'k' }) },
  {
    store: 'app',
    name: 'set',
    call: (c) => c.storage.set({ blockToken: TOKEN, key: 'k', value: 1 }),
  },
  { store: 'app', name: 'delete', call: (c) => c.storage.delete({ blockToken: TOKEN, key: 'k' }) },
  { store: 'app', name: 'list', call: (c) => c.storage.list({ blockToken: TOKEN }) },
  { store: 'app', name: 'getQuota', call: (c) => c.storage.getQuota({ blockToken: TOKEN }) },
  { store: 'shared', name: 'list', call: (c) => c.shared.list({ blockToken: TOKEN }) },
  { store: 'shared', name: 'get', call: (c) => c.shared.get({ blockToken: TOKEN, key: KEY }) },
  {
    store: 'shared',
    name: 'getCount',
    call: (c) => c.shared.getCount({ blockToken: TOKEN, key: KEY }),
  },
  {
    store: 'shared',
    name: 'getCounts',
    call: (c) => c.shared.getCounts({ blockToken: TOKEN, keys: [KEY] }),
  },
  {
    store: 'shared',
    name: 'append',
    call: (c) => c.shared.append({ blockToken: TOKEN, value: { title: 't' } }),
  },
  {
    store: 'shared',
    name: 'update',
    call: (c) => c.shared.update({ blockToken: TOKEN, key: KEY, value: { title: 't' } }),
  },
  { store: 'shared', name: 'vote', call: (c) => c.shared.vote({ blockToken: TOKEN, key: KEY }) },
  {
    store: 'shared',
    name: 'unvote',
    call: (c) => c.shared.unvote({ blockToken: TOKEN, key: KEY }),
  },
  {
    store: 'shared',
    name: 'withdraw',
    call: (c) => c.shared.withdraw({ blockToken: TOKEN, key: KEY }),
  },
  {
    store: 'shared',
    name: 'report',
    call: (c) => c.shared.report({ blockToken: TOKEN, key: KEY }),
  },
];

const caller = () => appsRouter.createCaller(fakeCtx() as never);
const label = (c: Case) => `${c.store}.${c.name}`;

async function settle(p: Promise<unknown>): Promise<unknown> {
  try {
    return await p;
  } catch (e) {
    return e;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsFlipt.mockResolvedValue(false);
  mockVerifyBlockToken.mockResolvedValue(null);
  mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('legacy-store shutdown — bridge procedures', () => {
  it('covers every procedure on both legacy-store routers', () => {
    const procs = [
      ...Object.keys(appsStorageRouter._def.procedures).map((n) => `app.${n}`),
      ...Object.keys(appsSharedRouter._def.procedures).map((n) => `shared.${n}`),
    ];
    expect(procs.length).toBeGreaterThan(0);
    expect(procs.sort()).toEqual(CASES.map(label).sort());
  });

  it.each(CASES.map((c) => [label(c), c] as const))(
    'flag on: %s refuses with legacy_store_removed before verifying the token',
    async (_name, c) => {
      mockIsFlipt.mockImplementation(async (flag) => flag === FLAG);

      const err = await settle(c.call(caller()));

      expect(err).toBeInstanceOf(TRPCError);
      expect((err as TRPCError).code).toBe('PRECONDITION_FAILED');
      expect((err as TRPCError).message).toBe(
        c.store === 'app'
          ? `legacy_store_removed: the legacy app storage (useAppStorage) has been removed. Move this app to the document store: ${GUIDE}`
          : `legacy_store_removed: the legacy shared storage (useSharedStorage) has been removed. Move this app to the document store: ${GUIDE}`
      );
      expect(mockVerifyBlockToken).not.toHaveBeenCalled();
    }
  );

  it.each(CASES.map((c) => [label(c), c] as const))(
    'flag off: %s reaches token verification',
    async (_name, c) => {
      const result = await settle(c.call(caller()));

      expect(mockVerifyBlockToken).toHaveBeenCalledWith(TOKEN);
      expect((result as TRPCError | undefined)?.code).not.toBe('PRECONDITION_FAILED');
    }
  );

  // Invariant guard (green before the change too): a failing flag eval keeps the bridge working.
  it.each(CASES.map((c) => [label(c), c] as const))(
    'flag eval throws: %s still reaches token verification',
    async (_name, c) => {
      mockIsFlipt.mockRejectedValue(new Error('flipt unreachable'));

      const result = await settle(c.call(caller()));

      expect(mockVerifyBlockToken).toHaveBeenCalledWith(TOKEN);
      expect((result as TRPCError | undefined)?.code).not.toBe('PRECONDITION_FAILED');
    }
  );
});
