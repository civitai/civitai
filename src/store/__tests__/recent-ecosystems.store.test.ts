// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The store reads storage when its module loads, so each test loads it afresh.
const load = async () => {
  vi.resetModules();
  return import('~/store/recent-ecosystems.store');
};

describe('recent ecosystems', () => {
  beforeEach(() => localStorage.clear());

  it('carries over the list kept under the old key', async () => {
    localStorage.setItem('generation-recent-ecosystems', JSON.stringify(['Flux1', 'SDXL']));
    const { useRecentEcosystemsStore } = await load();
    expect(useRecentEcosystemsStore.getState().recent).toEqual(['Flux1', 'SDXL']);
  });

  it('moves a tracked ecosystem to the front, once, and keeps it across loads', async () => {
    const first = await load();
    first.trackRecentEcosystem('SDXL');
    first.trackRecentEcosystem('Flux1');
    first.trackRecentEcosystem('SDXL');
    expect(first.useRecentEcosystemsStore.getState().recent).toEqual(['SDXL', 'Flux1']);

    const next = await load();
    expect(next.useRecentEcosystemsStore.getState().recent).toEqual(['SDXL', 'Flux1']);
  });
});
