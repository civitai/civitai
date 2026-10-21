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
