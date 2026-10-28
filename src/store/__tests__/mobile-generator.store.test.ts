// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The restore runs once per page load, so each test loads the modules afresh.
const load = async () => {
  vi.resetModules();
  const store = await import('~/store/mobile-generator.store');
  const { useGenerationPanelStore } = await import('~/store/generation-panel.store');
  return { ...store, view: () => useGenerationPanelStore.getState().view };
};

describe('mobile generator view', () => {
  beforeEach(() => localStorage.clear());

  it('opens on the form when nothing is saved (a first visit)', async () => {
    const { restoreMobileGeneratorView, view } = await load();
    restoreMobileGeneratorView();
    expect(view()).toBe('generate');
  });

  it('opens as it was left on the last page load, and only once', async () => {
    const first = await load();
    first.restoreMobileGeneratorView();
    first.saveMobileGeneratorView('feed');

    const next = await load();
    next.restoreMobileGeneratorView();
    expect(next.view()).toBe('feed');

    next.saveMobileGeneratorView('generate');
    localStorage.setItem('mobile-generator-view', 'queue');
    next.restoreMobileGeneratorView();
    expect(next.view()).toBe('feed');
  });
});
