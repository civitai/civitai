import { describe, expect, it } from 'vitest';
import { loadConfig, poolSizeFromCpuMax } from '../config.ts';

describe('poolSizeFromCpuMax (cgroup v2 cpu.max)', () => {
  it.each([
    ['max 100000', 16, 16],
    ['100000 100000', 16, 1],
    ['150000 100000', 16, 2],
    ['200000 100000', 16, 2],
    ['50000 100000', 16, 1],
    ['800000 100000', 4, 4],
    [undefined, 6, 6],
    ['garbage', 6, 6],
    ['0 100000', 6, 6],
  ])('cpu.max=%s with %i cores -> %i workers', (cpuMax, cores, expected) => {
    expect(poolSizeFromCpuMax(cpuMax, cores)).toBe(expected);
  });
});

describe('loadConfig', () => {
  const secret = 's'.repeat(32);

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['another value', 'both'],
  ])('refuses a RUNNER_MODE that is %s', (_what, mode) => {
    expect(() => loadConfig({ STORAGE_HOOK_RUNNER_SECRET: secret, RUNNER_MODE: mode })).toThrow(
      'RUNNER_MODE must be check or remix'
    );
  });

  it('MAX_PER_APP defaults to 4 in remix mode, whatever MAX_QUEUE is', () => {
    const remix = { STORAGE_HOOK_RUNNER_SECRET: secret, RUNNER_MODE: 'remix', MAX_QUEUE: '64' };
    expect(loadConfig(remix)).toMatchObject({ mode: 'remix', maxPerApp: 4 });
    // POSITIVE CONTROL: the same queue in check mode keeps a quarter of it.
    expect(loadConfig({ ...remix, RUNNER_MODE: 'check' }).maxPerApp).toBe(16);
    expect(loadConfig({ ...remix, MAX_PER_APP: '2' }).maxPerApp).toBe(2);
  });

  it('trims the secret: a trailing newline or surrounding spaces are not part of it', () => {
    for (const raw of [`${secret}\n`, `${secret}\r\n`, `  ${secret}\t`]) {
      expect(loadConfig({ STORAGE_HOOK_RUNNER_SECRET: raw, RUNNER_MODE: 'check' }).secret).toBe(
        secret
      );
    }
  });

  it('a secret under 32 characters after trimming is refused', () => {
    expect(() =>
      loadConfig({ STORAGE_HOOK_RUNNER_SECRET: `${'s'.repeat(31)}\n`, RUNNER_MODE: 'check' })
    ).toThrow('STORAGE_HOOK_RUNNER_SECRET must be at least 32 chars');
  });

  it('POOL_SIZE overrides the default', () => {
    expect(
      loadConfig({ STORAGE_HOOK_RUNNER_SECRET: secret, RUNNER_MODE: 'check', POOL_SIZE: '3' })
        .poolSize
    ).toBe(3);
  });

  it('MAX_PER_APP defaults to a quarter of MAX_QUEUE, rounded up', () => {
    expect(
      loadConfig({ STORAGE_HOOK_RUNNER_SECRET: secret, RUNNER_MODE: 'check', MAX_QUEUE: '10' })
        .maxPerApp
    ).toBe(3);
    expect(
      loadConfig({
        STORAGE_HOOK_RUNNER_SECRET: secret,
        RUNNER_MODE: 'check',
        MAX_QUEUE: '10',
        MAX_PER_APP: '7',
      }).maxPerApp
    ).toBe(7);
  });
});
