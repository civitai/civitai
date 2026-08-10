import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptSdk from '@flipt-io/flipt-client-js';

const evaluateBoolean = vi.fn(() => ({ enabled: true }));
const evaluateVariant = vi.fn(() => ({ match: true, variantKey: 'primary' }));
const init = vi.fn(async () => ({ evaluateBoolean, evaluateVariant, refresh: async () => {} }));

vi.mock('@flipt-io/flipt-client-js', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptSdk>()),
  FliptClient: { init: (...args: unknown[]) => init(...(args as [])) },
}));

import { createFliptClient } from '../client';

const baseConfig = {
  url: 'http://flipt.test',
  clientToken: 'token',
  environment: 'test-env',
  updateIntervalSeconds: 60,
  initTimeoutMs: 1000,
  failureCooldownMs: 30_000,
  evalCacheTtlMs: 10_000,
  evalCacheMaxEntries: 100,
  localOverrides: {},
  log: () => {},
};

describe('createFliptClient', () => {
  beforeEach(() => {
    evaluateBoolean.mockReset();
    evaluateBoolean.mockImplementation(() => ({ enabled: true }));
    evaluateVariant.mockReset();
    evaluateVariant.mockImplementation(() => ({ match: true, variantKey: 'primary' }));
    init.mockReset();
    init.mockImplementation(async () => ({
      evaluateBoolean,
      evaluateVariant,
      refresh: async () => {},
    }));
  });

  it('memoizes repeated evaluations of the same (flag, entity, context)', async () => {
    const flipt = createFliptClient(baseConfig);
    await flipt.isEnabled('some-flag', 'user-1');
    await flipt.isEnabled('some-flag', 'user-1');
    expect(evaluateBoolean).toHaveBeenCalledTimes(1);

    await flipt.isEnabled('some-flag', 'user-2');
    expect(evaluateBoolean).toHaveBeenCalledTimes(2);
  });

  it('skips the cache for bypassed flags', async () => {
    const flipt = createFliptClient({ ...baseConfig, cacheBypass: ['kill-switch'] });
    await flipt.isEnabled('kill-switch');
    await flipt.isEnabled('kill-switch');
    expect(evaluateBoolean).toHaveBeenCalledTimes(2);
  });

  it('does not evaluate at all when a local override is set', async () => {
    const flipt = createFliptClient({
      ...baseConfig,
      localOverrides: { 'off-flag': 'off', 'variant-flag': 'secondary' },
    });
    expect(await flipt.isEnabled('off-flag')).toBe(false);
    expect(await flipt.getVariant('variant-flag')).toBe('secondary');
    expect(init).not.toHaveBeenCalled();
    expect(evaluateBoolean).not.toHaveBeenCalled();
  });

  it('ignores local overrides in getBoolean', async () => {
    const flipt = createFliptClient({ ...baseConfig, localOverrides: { 'off-flag': 'off' } });
    expect(await flipt.getBoolean('off-flag')).toBe(true);
    expect(evaluateBoolean).toHaveBeenCalledTimes(1);
  });

  it('fails closed and holds the circuit open after an init failure', async () => {
    init.mockImplementation(async () => {
      throw new Error('boom');
    });
    const onInitError = vi.fn();
    const flipt = createFliptClient({ ...baseConfig, onInitError });

    expect(await flipt.isEnabled('any-flag')).toBe(false);
    expect(await flipt.isEnabled('any-flag')).toBe(false);
    expect(init).toHaveBeenCalledTimes(1);
    expect(onInitError).toHaveBeenCalledTimes(1);
  });

  it('fails closed when an evaluation throws', async () => {
    evaluateBoolean.mockImplementation(() => {
      throw new Error('unknown flag');
    });
    const onEvalError = vi.fn();
    const flipt = createFliptClient({ ...baseConfig, onEvalError });
    expect(await flipt.isEnabled('missing')).toBe(false);
    expect(onEvalError).toHaveBeenCalledWith(expect.any(Error), 'missing');
  });

  it('returns null from isEnabledSync until the client is initialized', async () => {
    const flipt = createFliptClient(baseConfig);
    expect(flipt.isEnabledSync('some-flag')).toBeNull();
    await flipt.ensureInitialized();
    expect(flipt.isEnabledSync('some-flag')).toBe(true);
  });

  it('degrades to fail-closed when connection config is missing', async () => {
    const onInitError = vi.fn();
    const flipt = createFliptClient({
      ...baseConfig,
      url: undefined,
      clientToken: undefined,
      onInitError,
    });
    expect(await flipt.isEnabled('some-flag')).toBe(false);
    expect(onInitError).toHaveBeenCalledTimes(1);
    expect(init).not.toHaveBeenCalled();
  });

  it('reports no variant match as null', async () => {
    evaluateVariant.mockImplementation(() => ({ match: false, variantKey: 'primary' }));
    const flipt = createFliptClient(baseConfig);
    expect(await flipt.getVariant('some-flag')).toBeNull();
  });
});
