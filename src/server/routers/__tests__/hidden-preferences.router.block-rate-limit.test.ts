import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EnvOther from '~/env/other';
import type * as RedisAtomic from '~/server/redis/atomic';
import type * as UserPreferencesService from '~/server/services/user-preferences.service';

// The real `rateLimit` middleware runs here (every sibling router suite stubs it), so
// `isTest` must be false or it early-returns before reading any attempts.
const { mockToggleHidden, mockHSetWithTTL } = vi.hoisted(() => ({
  mockToggleHidden: vi.fn(async () => ({ added: [], removed: [] })),
  mockHSetWithTTL: vi.fn(async () => undefined),
}));

vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferencesService>()),
  toggleHidden: mockToggleHidden,
}));
vi.mock('~/env/other', async () => ({
  ...(await vi.importActual<typeof EnvOther>('~/env/other')),
  isDev: false,
  isTest: false,
  isPreview: false,
}));
vi.mock('~/server/redis/atomic', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisAtomic>()),
  hSetWithTTL: mockHSetWithTTL,
}));

import { TRPCError } from '@trpc/server';
import { hiddenPreferencesRouter } from '../hidden-preferences.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const mockHGet = redisMock.redis.packed.hGet;

function ctxFor(user: { id: number; isModerator: boolean }) {
  return {
    acceptableOrigin: true,
    user: { ...user, tier: 'free', username: 'u', onboarding: 0x1f } as never,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  };
}

type ToggleInput = Parameters<
  ReturnType<typeof hiddenPreferencesRouter.createCaller>['toggleHidden']
>[0];

function call(input: ToggleInput, user = { id: 5, isModerator: false }) {
  return hiddenPreferencesRouter.createCaller(ctxFor(user) as never).toggleHidden(input);
}

const block: ToggleInput = { kind: 'blockedUser', data: [{ id: 99 }], hidden: true };

/** `n` recorded attempts spread evenly across the `spanMs` ending `offsetMs` before now. */
function attemptsSpanning(n: number, spanMs: number, offsetMs = 0) {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => now - offsetMs - Math.round((spanMs * i) / n));
}

async function codeOf(promise: Promise<unknown>) {
  return promise.then(
    () => null,
    (e: unknown) => (e instanceof TRPCError ? e.code : e)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHGet.mockResolvedValue([]);
});

describe('hiddenPreferences.toggleHidden — block-user rate limit', () => {
  it('refuses the 11th block inside a minute, before the service runs', async () => {
    mockHGet.mockResolvedValue(attemptsSpanning(10, 50_000));

    expect(await codeOf(call(block))).toBe('TOO_MANY_REQUESTS');
    expect(mockToggleHidden).not.toHaveBeenCalled();
  });

  it('allows the 10th block inside a minute', async () => {
    mockHGet.mockResolvedValue(attemptsSpanning(9, 50_000));

    expect(await codeOf(call(block))).toBeNull();
    expect(mockToggleHidden).toHaveBeenCalledTimes(1);
    expect(mockHSetWithTTL).toHaveBeenCalledTimes(1);
  });

  it('refuses the 51st block in a day, even when spread out', async () => {
    mockHGet.mockResolvedValue(attemptsSpanning(50, 20 * 3600_000, 120_000));

    expect(await codeOf(call(block))).toBe('TOO_MANY_REQUESTS');
  });

  it('allows the 50th block in a day, and ages out older ones', async () => {
    mockHGet.mockResolvedValue([
      ...attemptsSpanning(49, 20 * 3600_000, 120_000),
      ...attemptsSpanning(100, 3600_000, 25 * 3600_000),
    ]);

    expect(await codeOf(call(block))).toBeNull();
  });

  it('counts a flip with no explicit intent as a block', async () => {
    mockHGet.mockResolvedValue(attemptsSpanning(10, 50_000));

    expect(await codeOf(call({ kind: 'blockedUser', data: [{ id: 99 }] }))).toBe(
      'TOO_MANY_REQUESTS'
    );
  });

  it('never meters an unblock', async () => {
    mockHGet.mockResolvedValue(attemptsSpanning(200, 50_000));

    expect(await codeOf(call({ ...block, hidden: false }))).toBeNull();
    expect(mockHGet).not.toHaveBeenCalled();
  });

  it('never meters other hidden kinds', async () => {
    mockHGet.mockResolvedValue(attemptsSpanning(200, 50_000));

    expect(await codeOf(call({ kind: 'user', data: [{ id: 99 }], hidden: true }))).toBeNull();
    expect(mockHGet).not.toHaveBeenCalled();
  });

  it('exempts moderators', async () => {
    mockHGet.mockResolvedValue(attemptsSpanning(200, 50_000));

    expect(await codeOf(call(block, { id: 1, isModerator: true }))).toBeNull();
  });

  it('buckets block attempts under their own key, not the shared toggle path', async () => {
    await call(block);

    expect(mockHGet).toHaveBeenCalledWith(expect.stringMatching(/:block-user$/), 'user:5');
  });
});
