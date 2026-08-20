// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';

import type { Debouncer } from '~/utils/debouncer';
import { useDebouncer } from '~/utils/debouncer';

// React 18.3 exposes `act` on the `react` export, but our @types/react (18.0.14) predates that
// typing. Use the runtime `React.act` and borrow the correctly-typed signature.
const act = (React as unknown as { act: typeof actType }).act;

const TIMEOUT = 1000;

function renderDebouncer() {
  const container = document.createElement('div');
  const root = createRoot(container);
  let debouncer: Debouncer | undefined;
  function Probe() {
    debouncer = useDebouncer(TIMEOUT);
    return null;
  }
  act(() => {
    root.render(React.createElement(Probe));
  });
  return {
    debouncer: debouncer as Debouncer,
    unmount: () =>
      act(() => {
        root.unmount();
      }),
  };
}

beforeEach(() => {
  // Only the timer functions the debouncer uses — faking React 18's MessageChannel scheduler
  // would stop `act` from flushing renders.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useDebouncer', () => {
  it('defers the call until the window elapses', () => {
    const { debouncer, unmount } = renderDebouncer();
    const fn = vi.fn();

    debouncer(fn);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(TIMEOUT);
    expect(fn).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('keeps only the latest call in a window', () => {
    const { debouncer, unmount } = renderDebouncer();
    const first = vi.fn();
    const second = vi.fn();

    debouncer(first);
    vi.advanceTimersByTime(TIMEOUT - 1);
    debouncer(second);
    vi.advanceTimersByTime(TIMEOUT);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('flush runs the pending call immediately AND exactly once', () => {
    const { debouncer, unmount } = renderDebouncer();
    const fn = vi.fn();

    debouncer(fn);
    debouncer.flush();
    expect(fn).toHaveBeenCalledTimes(1);

    // The timer is still armed at this point. Without flush clearing it, the same edit is
    // written a second time when the window elapses.
    vi.advanceTimersByTime(TIMEOUT * 5);
    expect(fn).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('flush after the window elapsed does not repeat the call', () => {
    const { debouncer, unmount } = renderDebouncer();
    const fn = vi.fn();

    debouncer(fn);
    vi.advanceTimersByTime(TIMEOUT);
    expect(fn).toHaveBeenCalledTimes(1);

    debouncer.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('flush with nothing pending is a no-op', () => {
    const { debouncer, unmount } = renderDebouncer();
    expect(() => debouncer.flush()).not.toThrow();
    unmount();
  });

  it('cancel drops the pending call', () => {
    const { debouncer, unmount } = renderDebouncer();
    const fn = vi.fn();

    debouncer(fn);
    debouncer.cancel();
    vi.advanceTimersByTime(TIMEOUT * 5);

    expect(fn).not.toHaveBeenCalled();
    unmount();
  });

  // This is the behaviour that makes `flush` necessary rather than merely convenient: anything
  // navigating away deliberately has to flush, or the last edit is discarded with no error.
  it('drops a pending call on unmount', () => {
    const { debouncer, unmount } = renderDebouncer();
    const fn = vi.fn();

    debouncer(fn);
    unmount();
    vi.advanceTimersByTime(TIMEOUT * 5);

    expect(fn).not.toHaveBeenCalled();
  });
});
