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

  it('POOL_SIZE overrides the default', () => {
    expect(loadConfig({ STORAGE_HOOK_RUNNER_SECRET: secret, POOL_SIZE: '3' }).poolSize).toBe(3);
  });

  it('MAX_PER_APP defaults to a quarter of MAX_QUEUE, rounded up', () => {
    expect(loadConfig({ STORAGE_HOOK_RUNNER_SECRET: secret, MAX_QUEUE: '10' }).maxPerApp).toBe(3);
    expect(
      loadConfig({ STORAGE_HOOK_RUNNER_SECRET: secret, MAX_QUEUE: '10', MAX_PER_APP: '7' })
        .maxPerApp
    ).toBe(7);
  });
});
