import { describe, expect, it, vi } from 'vitest';
import type * as Redis from '@civitai/redis';

const cacheEval = vi.hoisted(() => vi.fn(async (_script: string, _options: unknown) => ['q:3']));
const sysEval = vi.hoisted(() => vi.fn(async (_script: string, _options: unknown) => []));
vi.mock('@civitai/redis', async (original) => ({
  ...(await original<typeof Redis>()),
  createCacheRedis: () => ({ eval: cacheEval }),
  createSysRedis: () => ({ eval: sysEval }),
}));

const { skipStore } = await import('./skip-runtime');

// Skips are loss-tolerant, so they stay off the durable sys store.
describe('skipStore', () => {
  it('keeps skips on the cache cluster, not the sys store', async () => {
    await skipStore.add(7, { kind: 'queue', id: 3 }, new Date(5));
    await skipStore.list(7);

    expect(cacheEval).toHaveBeenCalled();
    expect(sysEval).not.toHaveBeenCalled();
  });
});
