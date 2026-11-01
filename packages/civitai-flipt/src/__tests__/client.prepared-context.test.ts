import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptSdk from '@flipt-io/flipt-client-js';
import type * as Cache from '../cache';

const evaluateBoolean = vi.fn((req: { flagKey: string; entityId: string }) => ({
  enabled: req.entityId === 'u1',
}));

vi.mock('@flipt-io/flipt-client-js', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptSdk>()),
  FliptClient: {
    init: async () => ({ evaluateBoolean, evaluateVariant: vi.fn(), refresh: async () => {} }),
  },
}));

// Count every build of the context part of a cache key.
const suffixBuilds = vi.hoisted(() => ({ count: 0 }));
vi.mock('../cache', async (importOriginal) => {
  const real = await importOriginal<typeof Cache>();
  return {
    ...real,
    fliptCacheKeySuffix: (...args: Parameters<typeof real.fliptCacheKeySuffix>) => {
      suffixBuilds.count++;
      return real.fliptCacheKeySuffix(...args);
    },
  };
});

import { fliptCacheKey } from '../cache';
import { createFliptClient, prepareFliptContext } from '../client';

const config = {
  url: 'http://flipt.test',
  clientToken: 'token',
  environment: 'test-env',
  updateIntervalSeconds: 60,
  initTimeoutMs: 1000,
  failureCooldownMs: 30_000,
  evalCacheTtlMs: 10_000,
  evalCacheMaxEntries: 1000,
  localOverrides: {},
  log: () => {},
};
const context = { userId: '1', tier: 'gold', isModerator: 'false' };
const FLAGS = Array.from({ length: 40 }, (_, i) => `flag-${i}`);

describe('prepareFliptContext', () => {
  beforeEach(() => {
    suffixBuilds.count = 0;
    evaluateBoolean.mockClear();
  });

  it('builds the context part of the cache key once for a whole batch of flags', async () => {
    const flipt = createFliptClient(config);
    await flipt.ensureInitialized();

    const prepared = prepareFliptContext('u1', context);
    expect(suffixBuilds.count).toBe(1);
    for (const flag of FLAGS) flipt.isEnabledSync(flag, 'u1', prepared);
    for (const flag of FLAGS) flipt.isEnabledSync(flag, 'u1', prepared);
    expect(suffixBuilds.count).toBe(1);
    // ...where a plain context builds it on every evaluation.
    for (const flag of FLAGS) flipt.isEnabledSync(flag, 'u1', context);
    expect(suffixBuilds.count).toBe(1 + FLAGS.length);
  });

  it('is the same input as the plain context: same values, same cache entries', async () => {
    const flipt = createFliptClient(config);
    await flipt.ensureInitialized();
    const prepared = prepareFliptContext('u1', context);

    expect(Object.isFrozen(prepared)).toBe(true);
    expect({ ...prepared }).toEqual(context);
    expect(JSON.stringify(prepared)).toBe(JSON.stringify(context));

    // Cached through the plain context, hit through the prepared one, and vice versa.
    expect(flipt.isEnabledSync('a', 'u1', context)).toBe(true);
    expect(flipt.isEnabledSync('a', 'u1', prepared)).toBe(true);
    expect(flipt.isEnabledSync('b', 'u1', prepared)).toBe(true);
    expect(flipt.isEnabledSync('b', 'u1', context)).toBe(true);
    expect(evaluateBoolean).toHaveBeenCalledTimes(2);
    // The engine is handed the plain values.
    expect(evaluateBoolean.mock.calls[1][0]).toEqual({ flagKey: 'b', entityId: 'u1', context });
  });

  it('is ignored for a different entity id, which keeps its own cache entry', async () => {
    const flipt = createFliptClient(config);
    await flipt.ensureInitialized();
    const preparedForU1 = prepareFliptContext('u1', context);

    expect(flipt.isEnabledSync('a', 'u1', preparedForU1)).toBe(true);
    // Same context object, other entity: must not read u1's entry (u2 evaluates false).
    expect(flipt.isEnabledSync('a', 'u2', preparedForU1)).toBe(false);
    expect(evaluateBoolean).toHaveBeenCalledTimes(2);
  });

  it('keys exactly as fliptCacheKey does', () => {
    // The precomputed key must be the one unprepared calls build, or the two would split the cache.
    const flag = 'f';
    for (const [entityId, ctx] of [
      ['anonymous', {}],
      ['u|1', { 'a&b': 'c=d', z: '1', a: '2' }],
    ] as const) {
      const viaSuffix = flag + suffixFor(entityId, ctx);
      expect(viaSuffix).toBe(fliptCacheKey(flag, entityId, ctx));
    }
  });
});

function suffixFor(entityId: string, ctx: Record<string, string>): string {
  const prepared = prepareFliptContext(entityId, ctx) as unknown as Record<
    symbol,
    { suffix: string }
  >;
  const symbol = Object.getOwnPropertySymbols(prepared)[0];
  return prepared[symbol].suffix;
}
