import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Regression coverage for the Chrome dialog-close crash:
//   TypeError: null is not an object (evaluating 'navigation.currentEntry.index')
//     at getHasClientHistory (src/store/ClientHistoryStore.tsx)
// The Navigation API's `navigation.currentEntry` is nullable at runtime (null
// when the document is not fully active — prerender, bfcache-restoring, or a
// detached/inactive document). The old code read `.index` off it unguarded, so
// closing a routed dialog while currentEntry was null threw and broke the close
// handler. This is the `navigation.currentEntry` sibling of the #3006
// Safari-null-`history.state` family (distinct signature).
//
// `getHasClientHistory` picks its branch off the module-scope `hasNavigation`
// const, which is evaluated ONCE at import against `window.navigation`. So each
// case sets up `window`/`navigation` (globalThis) BEFORE a fresh import — a
// truthy `navigation` object (even with a null `currentEntry`) makes
// `hasNavigation` true and exercises the crashing branch.
describe('getHasClientHistory (Navigation API branch)', () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const originalNavigation = (globalThis as { navigation?: unknown }).navigation;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
    (globalThis as { navigation?: unknown }).navigation = originalNavigation;
    vi.resetModules();
  });

  async function loadWithCurrentEntry(currentEntry: unknown) {
    const navObj = { currentEntry };
    (globalThis as { window?: unknown }).window = { navigation: navObj };
    (globalThis as { navigation?: unknown }).navigation = navObj;
    const mod = await import('~/store/ClientHistoryStore');
    return mod.getHasClientHistory;
  }

  it('returns false (does NOT throw) when navigation.currentEntry is null — the crash', async () => {
    const getHasClientHistory = await loadWithCurrentEntry(null);
    expect(() => getHasClientHistory()).not.toThrow();
    expect(getHasClientHistory()).toBe(false);
  });

  it('returns false when currentEntry is undefined (not throw)', async () => {
    const getHasClientHistory = await loadWithCurrentEntry(undefined);
    expect(() => getHasClientHistory()).not.toThrow();
    expect(getHasClientHistory()).toBe(false);
  });

  it('returns true when currentEntry.index > 0 (has client history — happy path)', async () => {
    const getHasClientHistory = await loadWithCurrentEntry({ index: 2 });
    expect(getHasClientHistory()).toBe(true);
  });

  it('returns false when currentEntry.index is 0 (first entry — no client history)', async () => {
    const getHasClientHistory = await loadWithCurrentEntry({ index: 0 });
    expect(getHasClientHistory()).toBe(false);
  });
});
