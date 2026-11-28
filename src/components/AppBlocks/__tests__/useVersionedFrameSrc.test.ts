// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

/**
 * `useVersionedFrameSrc` reads the viewer's `appBlocksVersionedFramePath` flag ONCE PER MOUNT.
 * A flags overlay that arrives after the frame loaded must not move the `src` of a running app:
 * that is a navigation of the frame, and it would discard the app's state. A change of the src
 * or the sha (a soft navigation to another app, a new version) still recomputes.
 */

const flags: { current: Record<string, boolean> | null } = { current: {} };
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useOptionalFeatureFlags: () => flags.current,
}));

import { useVersionedFrameSrc } from '../versionedFrameSrc';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SHA = '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567';
const SHA2 = 'fedcba98765432100123456789abcdeffedcba98';
const ROOT = 'https://my-app.civit.ai/';

function mount(src: string, sha: string | null) {
  const result = { current: '' };
  const root = createRoot(document.createElement('div'));
  let args: [string, string | null] = [src, sha];
  function Probe() {
    result.current = useVersionedFrameSrc(...args);
    return null;
  }
  const render = () =>
    act(() => {
      root.render(createElement(Probe));
    });
  render();
  return {
    result,
    rerender: (nextSrc: string, nextSha: string | null) => {
      args = [nextSrc, nextSha];
      render();
      return result.current;
    },
  };
}

describe('useVersionedFrameSrc — the flag is frozen for the mount', () => {
  it('a flag that turns ON after mount does not move the src', () => {
    flags.current = {};
    const h = mount(ROOT, SHA);
    expect(h.result.current).toBe(ROOT);
    flags.current = { appBlocksVersionedFramePath: true };
    expect(h.rerender(ROOT, SHA)).toBe(ROOT);
  });

  it('a flag that turns OFF after mount does not move the src', () => {
    flags.current = { appBlocksVersionedFramePath: true };
    const h = mount(ROOT, SHA);
    expect(h.result.current).toBe(`https://my-app.civit.ai/v/${SHA}/`);
    flags.current = {};
    expect(h.rerender(ROOT, SHA)).toBe(`https://my-app.civit.ai/v/${SHA}/`);
  });

  it('a new sha (a new version) still recomputes, under the frozen flag', () => {
    flags.current = { appBlocksVersionedFramePath: true };
    const h = mount(ROOT, SHA);
    expect(h.rerender(ROOT, SHA2)).toBe(`https://my-app.civit.ai/v/${SHA2}/`);
  });

  it('no flags provider: the root', () => {
    flags.current = null;
    expect(mount(ROOT, SHA).result.current).toBe(ROOT);
  });
});
