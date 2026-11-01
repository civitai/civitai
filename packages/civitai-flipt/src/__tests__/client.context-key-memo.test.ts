import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptSdk from '@flipt-io/flipt-client-js';
import type * as Cache from '../cache';

// Answers depend on the entity and on one context value, so a cache entry read under the wrong
// key returns a visibly wrong answer.
const evaluateBoolean = vi.fn(
  (req: { flagKey: string; entityId: string; context: Record<string, string> }) => ({
    enabled: req.entityId === 'u1' && req.context.tier !== 'free',
  })
);

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

import { createFliptClient } from '../client';
import { buildFliptContext } from '../context';

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
const FLAGS = Array.from({ length: 40 }, (_, i) => `flag-${i}`);

async function client() {
  const flipt = createFliptClient(config);
  await flipt.ensureInitialized();
  return flipt;
}

describe('the eval-cache key of a context', () => {
  beforeEach(() => {
    suffixBuilds.count = 0;
    evaluateBoolean.mockClear();
  });

  it('is built once for a whole batch of flags evaluated with one built context', async () => {
    const flipt = await client();
    const ctx = buildFliptContext({ id: 1, tier: 'gold' });
    for (const flag of FLAGS) flipt.isEnabledSync(flag, 'u1', ctx);
    for (const flag of FLAGS) flipt.isEnabledSync(flag, 'u1', ctx);
    expect(suffixBuilds.count).toBe(1);
  });

  it('is built per evaluation for a context that is not frozen', async () => {
    const flipt = await client();
    const ctx = { ...buildFliptContext({ id: 1, tier: 'gold' }) };
    for (const flag of FLAGS) flipt.isEnabledSync(flag, 'u1', ctx);
    expect(suffixBuilds.count).toBe(FLAGS.length);
  });

  it('shares cache entries with an equal unfrozen context', async () => {
    const flipt = await client();
    const frozen = buildFliptContext({ id: 1, tier: 'gold' });
    const plain = { ...frozen };

    expect(flipt.isEnabledSync('a', 'u1', plain)).toBe(true);
    expect(flipt.isEnabledSync('a', 'u1', frozen)).toBe(true);
    expect(flipt.isEnabledSync('b', 'u1', frozen)).toBe(true);
    expect(flipt.isEnabledSync('b', 'u1', plain)).toBe(true);
    // One engine call per flag: each second read was a hit under the other context's key.
    expect(evaluateBoolean).toHaveBeenCalledTimes(2);
  });

  it('is per entity id: the same context with another entity keeps its own entry', async () => {
    const flipt = await client();
    const ctx = buildFliptContext({ id: 1, tier: 'gold' });

    expect(flipt.isEnabledSync('a', 'u1', ctx)).toBe(true);
    expect(flipt.isEnabledSync('a', 'u2', ctx)).toBe(false);
    expect(flipt.isEnabledSync('a', 'u1', ctx)).toBe(true);
    expect(evaluateBoolean).toHaveBeenCalledTimes(2);
  });

  it('is per context: two built contexts for different users never share an entry', async () => {
    const flipt = await client();
    const gold = buildFliptContext({ id: 1, tier: 'gold' });
    const free = buildFliptContext({ id: 1, tier: 'free' });

    expect(flipt.isEnabledSync('a', 'u1', gold)).toBe(true);
    expect(flipt.isEnabledSync('a', 'u1', free)).toBe(false);
    expect(evaluateBoolean).toHaveBeenCalledTimes(2);
  });
});
