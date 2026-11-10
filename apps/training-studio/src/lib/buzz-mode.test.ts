import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// buzzMode is module-scope state and `lock` is one-shot, so each test gets a fresh module.
async function fresh() {
  vi.resetModules();
  const { buzzMode } = await import('./buzz-mode.svelte');
  const { default: BlueFirstNote } = await import('./components/BlueFirstNote.svelte');
  // `render` must come from the same module graph as the component, or svelte's SSR context is lost.
  const { render } = await import('svelte/server');
  return { buzzMode, BlueFirstNote, render };
}

// The first import compiles the svelte modules (~3 s cold, ~0.1 s warm); doing it here keeps that cost
// out of whichever test runs first, where it sat against the 5 s limit and could spill into the next test.
beforeAll(() => fresh(), 30_000);

// The embed runs in a browser, where the stored choice decides the default; stub just enough of one.
function stubBrowser(stored: Record<string, string>) {
  const store = { ...stored };
  vi.stubGlobal('window', {});
  vi.stubGlobal('document', { documentElement: { classList: { toggle: vi.fn() } } });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => void (store[k] = v),
  });
  return store;
}
afterEach(() => vi.unstubAllGlobals());

describe('stored Blue-first choice', () => {
  it('defaults on, and only an explicit opt-out turns it off', async () => {
    stubBrowser({});
    expect((await fresh()).buzzMode.blueFirst).toBe(true);
    stubBrowser({ 'ts-buzz-blue-first': '1' });
    expect((await fresh()).buzzMode.blueFirst).toBe(true);
    stubBrowser({ 'ts-buzz-blue-first': '0' });
    expect((await fresh()).buzzMode.blueFirst).toBe(false);
  });

  it('persists the switch and survives a host lock', async () => {
    const store = stubBrowser({});
    const { buzzMode } = await fresh();
    buzzMode.lock('green');
    buzzMode.setBlueFirst(false);
    expect(store['ts-buzz-blue-first']).toBe('0');
    expect(store['ts-buzz-mode']).toBeUndefined();
    expect((await fresh()).buzzMode.blueFirst).toBe(false);
  });
});

describe('host-locked Buzz mode', () => {
  it('spends Blue first by default', async () => {
    const { buzzMode } = await fresh();
    buzzMode.lock('yellow');
    expect(buzzMode.currencies).toEqual(['blue', 'yellow']);
  });

  it('with Blue first off, a locked Yellow host charges Yellow only', async () => {
    const { buzzMode } = await fresh();
    buzzMode.lock('yellow');
    buzzMode.setBlueFirst(false);
    expect(buzzMode.currencies).toEqual(['yellow']);
  });

  it('with Blue first off, a locked Green host charges Green only', async () => {
    const { buzzMode } = await fresh();
    buzzMode.lock('green');
    buzzMode.setBlueFirst(false);
    expect(buzzMode.currencies).toEqual(['green']);
  });
});

describe('BlueFirstNote', () => {
  it('offers the Blue-first switch when the host locks the mode', async () => {
    const { buzzMode, BlueFirstNote, render } = await fresh();
    buzzMode.lock('yellow');
    const { body } = render(BlueFirstNote);
    expect(body).toContain('role="checkbox"');
    expect(body).toContain('Spend');
    expect(body).toContain('Blue</span> first');
  });

  it('leaves the switch to the header when the mode is not locked', async () => {
    const { BlueFirstNote, render } = await fresh();
    const { body } = render(BlueFirstNote);
    expect(body).not.toContain('role="checkbox"');
    expect(body).toContain('switch in the top bar');
  });

  it('says paid account only once Blue first is off', async () => {
    const { buzzMode, BlueFirstNote, render } = await fresh();
    buzzMode.lock('green');
    buzzMode.setBlueFirst(false);
    const { body } = render(BlueFirstNote);
    expect(body).toContain('Paid with your');
    expect(body).toContain('Buzz only');
    expect(body).not.toContain('first, then');
  });
});
