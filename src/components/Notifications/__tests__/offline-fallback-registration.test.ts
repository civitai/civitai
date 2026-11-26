// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * OfflineFallbackRegistration is the one piece of the offline-fallback change that reaches every
 * visitor, so its gate is pinned: production registers, a dev build does not unless
 * NEXT_PUBLIC_ENABLE_SW_DEV=1 (a stopped dev server must keep showing the browser's error).
 */
const state = vi.hoisted(() => ({ isProd: true, devFlag: undefined as string | undefined }));

vi.mock('~/env/other', () => ({
  get isProd() {
    return state.isProd;
  },
}));
vi.mock('~/env/client', () => ({
  env: {
    get NEXT_PUBLIC_ENABLE_SW_DEV() {
      return state.devFlag;
    },
  },
}));

import { OfflineFallbackRegistration } from '~/components/Notifications/OfflineFallbackRegistration';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const register = vi.fn();
const originalReadyState = Object.getOwnPropertyDescriptor(document, 'readyState');

function setReadyState(value: DocumentReadyState) {
  Object.defineProperty(document, 'readyState', { value, configurable: true });
}

function mount() {
  const root = createRoot(document.createElement('div'));
  act(() => root.render(createElement(OfflineFallbackRegistration)));
  return root;
}

beforeEach(() => {
  state.isProd = true;
  state.devFlag = undefined;
  register.mockReset().mockResolvedValue({});
  Object.defineProperty(navigator, 'serviceWorker', { value: { register }, configurable: true });
  setReadyState('complete');
});

afterEach(() => {
  if (originalReadyState) Object.defineProperty(document, 'readyState', originalReadyState);
  else delete (document as { readyState?: unknown }).readyState;
});

describe('OfflineFallbackRegistration', () => {
  it('production, page already loaded: registers /sw.js exactly once', () => {
    mount();
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith('/sw.js');
  });

  it('production, page still loading: waits for load, then registers once', () => {
    setReadyState('loading');
    mount();
    expect(register).not.toHaveBeenCalled();
    act(() => void window.dispatchEvent(new Event('load')));
    expect(register).toHaveBeenCalledTimes(1);
    act(() => void window.dispatchEvent(new Event('load')));
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('unmounting before load cancels the registration', () => {
    setReadyState('loading');
    const root = mount();
    act(() => root.unmount());
    act(() => void window.dispatchEvent(new Event('load')));
    expect(register).not.toHaveBeenCalled();
  });

  it('non-production without the flag: never registers, even after load', () => {
    state.isProd = false;
    setReadyState('loading');
    mount();
    act(() => void window.dispatchEvent(new Event('load')));
    expect(register).not.toHaveBeenCalled();
  });

  it('non-production with NEXT_PUBLIC_ENABLE_SW_DEV=1: registers', () => {
    state.isProd = false;
    state.devFlag = '1';
    mount();
    expect(register).toHaveBeenCalledWith('/sw.js');
  });

  it.each(['0', 'true', ''])('non-production with NEXT_PUBLIC_ENABLE_SW_DEV=%j: does not', (v) => {
    state.isProd = false;
    state.devFlag = v;
    mount();
    expect(register).not.toHaveBeenCalled();
  });

  it('a rejected register() is swallowed: a rejection handler is attached and it does not rethrow', () => {
    // A thenable records whichever form attaches the handler (.catch or .then(_, onRejected)).
    let onRejected: ((reason: unknown) => unknown) | undefined;
    const attach = (_ok?: unknown, fail?: (reason: unknown) => unknown) => {
      onRejected = fail;
      return thenable;
    };
    const thenable = {
      then: attach,
      catch: (fail: (reason: unknown) => unknown) => attach(0, fail),
    };
    register.mockReturnValue(thenable);
    mount();
    expect(onRejected).toBeTypeOf('function');
    expect(() => onRejected!(new Error('SecurityError'))).not.toThrow();
  });

  it('production, document interactive but not complete: still waits for load', () => {
    setReadyState('interactive');
    mount();
    expect(register).not.toHaveBeenCalled();
    act(() => void window.dispatchEvent(new Event('load')));
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('a browser without serviceWorker: mounts and does nothing', () => {
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    expect('serviceWorker' in navigator).toBe(false);
    expect(() => mount()).not.toThrow();
    expect(register).not.toHaveBeenCalled();
  });
});
