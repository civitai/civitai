import { afterEach, describe, expect, it, vi } from 'vitest';

// This suite runs without the Svelte compiler, so `$state` is a plain identity here: the test covers
// the module's toggle and its single shared instance, not reactivity.
const load = async () => {
  vi.stubGlobal('$state', <T>(v: T) => v);
  return (await import('../image-reveal.svelte')).imageReveal;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('imageReveal', () => {
  it('starts blurred and flips with each toggle', async () => {
    const reveal = await load();
    expect(reveal.on).toBe(false);
    reveal.toggle();
    expect(reveal.on).toBe(true);
    reveal.toggle();
    expect(reveal.on).toBe(false);
  });

  it('keeps the choice for every importer of the module, as when the page remounts', async () => {
    const first = await load();
    first.toggle();
    const second = (await import('../image-reveal.svelte')).imageReveal;
    expect(second.on).toBe(true);
  });
});

describe('imageReveal across reloads', () => {
  const memoryStorage = (initial: Record<string, string> = {}) => {
    const data = new Map(Object.entries(initial));
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      data,
    };
  };
  // A reload is a fresh module over the same browser storage.
  const reload = async (storage: unknown) => {
    vi.resetModules();
    vi.stubGlobal('localStorage', storage);
    return load();
  };

  it('a reveal survives a reload once restored', async () => {
    const storage = memoryStorage();
    const before = await reload(storage);
    before.toggle();
    const after = await reload(storage);
    expect(after.on).toBe(false); // blurred until mount, as the server rendered it
    after.restore();
    expect(after.on).toBe(true);
  });

  it('switching back to blurred survives a reload too', async () => {
    const storage = memoryStorage();
    const first = await reload(storage);
    first.toggle();
    first.toggle();
    const after = await reload(storage);
    after.restore();
    expect(after.on).toBe(false);
  });

  it.each([
    ['never chosen', memoryStorage()],
    ['an unreadable value', memoryStorage({ 'moderator.csam-holds.reveal-images': 'true' })],
  ])('stays blurred for %s', async (_label, storage) => {
    const reveal = await reload(storage);
    reveal.restore();
    expect(reveal.on).toBe(false);
  });

  it('stays blurred, and still toggles, when storage throws', async () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const reveal = await reload(broken);
    reveal.restore();
    expect(reveal.on).toBe(false);
    reveal.toggle();
    expect(reveal.on).toBe(true);
  });
});
