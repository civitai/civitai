// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A fresh copy of the store module, as a page reload would build it. */
async function loadStore() {
  vi.resetModules();
  return (await import('~/components/HatTurf/hat-turf.store')).useHatTurfStore;
}

describe('hat turf store', () => {
  beforeEach(() => localStorage.clear());

  it('keeps Show hats off across a reload', async () => {
    (await loadStore()).getState().setShowHats(false);

    expect((await loadStore()).getState().showHats).toBe(false);
  });

  it('shows hats by default and does not carry the picked hat across a reload', async () => {
    const first = await loadStore();
    expect(first.getState().showHats).toBe(true);
    first.getState().pick(42);

    expect((await loadStore()).getState().cosmeticId).toBeNull();
  });
});
