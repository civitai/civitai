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

const A = 1;
const B = 2;
const KEY_A = 'moderator.csam-holds.reveal-images:1';

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
    before.restore(A);
    before.toggle();
    const after = await reload(storage);
    expect(after.on).toBe(false); // blurred until mount, as the server rendered it
    after.restore(A);
    expect(after.on).toBe(true);
  });

  it('stores the choice under its key', async () => {
    const storage = memoryStorage();
    const reveal = await reload(storage);
    reveal.restore(A);
    reveal.toggle();
    expect(storage.data.get(KEY_A)).toBe('1');
  });

  it('coming back to the page keeps the choice made since, whatever storage says', async () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const reveal = await reload(broken);
    reveal.restore(A);
    reveal.toggle();
    reveal.restore(A); // the page remounted after a client navigation
    expect(reveal.on).toBe(true);

    // A write that failed must not let an older stored reveal come back.
    const stale = memoryStorage({ [KEY_A]: '1' });
    const again = await reload({ getItem: stale.getItem, setItem: broken.setItem });
    again.restore(A);
    again.toggle();
    again.restore(A);
    expect(again.on).toBe(false);
  });

  it('is one moderator’s choice: the next moderator in this browser starts blurred', async () => {
    const storage = memoryStorage();
    const first = await reload(storage);
    first.restore(A);
    first.toggle();
    const next = await reload(storage);
    next.restore(B);
    expect(next.on).toBe(false);
    // And B's own choice does not leak back to A.
    next.toggle();
    const back = await reload(storage);
    back.restore(A);
    expect(back.on).toBe(true);
    next.toggle();
    back.restore(A);
    expect(back.on).toBe(true);
  });

  it('switching moderators without a reload applies the new one’s choice', async () => {
    const storage = memoryStorage({ [KEY_A]: '1' });
    const reveal = await reload(storage);
    reveal.restore(A);
    expect(reveal.on).toBe(true);
    reveal.restore(B);
    expect(reveal.on).toBe(false);
  });

  it('ignores the per-browser entry earlier builds stored', async () => {
    const reveal = await reload(memoryStorage({ 'moderator.csam-holds.reveal-images': '1' }));
    reveal.restore(A);
    expect(reveal.on).toBe(false);
  });

  it('stores nothing for a toggle before anyone is known', async () => {
    const storage = memoryStorage();
    (await reload(storage)).toggle();
    expect(storage.data.size).toBe(0);
  });

  it('switching back to blurred survives a reload too', async () => {
    const storage = memoryStorage();
    const first = await reload(storage);
    first.restore(A);
    first.toggle();
    first.toggle();
    const after = await reload(storage);
    after.restore(A);
    expect(after.on).toBe(false);
  });

  it.each([
    ['never chosen', memoryStorage()],
    ['an unreadable value', memoryStorage({ [KEY_A]: 'true' })],
  ])('stays blurred for %s', async (_label, storage) => {
    const reveal = await reload(storage);
    reveal.restore(A);
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
    reveal.restore(A);
    expect(reveal.on).toBe(false);
    reveal.toggle();
    expect(reveal.on).toBe(true);
  });
});
