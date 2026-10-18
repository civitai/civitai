// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BuzzTypes } from '~/shared/constants/buzz.constants';
import { BUZZ_DELTA_QUIET_MS, useBuzzDeltaStore } from '~/store/buzz-delta.store';

const act = (React as unknown as { act: typeof actType }).act;

const { signal } = vi.hoisted(() => ({
  signal: { handler: undefined as undefined | ((update: unknown) => void) },
}));
vi.mock('~/components/Signals/SignalsProvider', () => ({
  useSignalConnection: (_message: string, handler: (update: unknown) => void) => {
    signal.handler = handler;
  },
}));

import { SignalNotifications } from '~/components/Signals/SignalsNotifications';

let container: HTMLDivElement;
let root: Root;

const update = (delta: number) =>
  act(() => {
    signal.handler!({ accountType: BuzzTypes.toApiType('yellow'), delta, balance: 0 });
  });

const settle = () =>
  act(() => {
    vi.advanceTimersByTime(BUZZ_DELTA_QUIET_MS);
  });

const status = () => container.querySelector('[role="status"]')!;

describe('SignalNotifications', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    useBuzzDeltaStore.getState().reset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        React.createElement(MantineProvider, null, React.createElement(SignalNotifications))
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useBuzzDeltaStore.getState().reset();
    vi.useRealTimers();
  });

  it('has an empty polite live region before anything happens', () => {
    expect(status().getAttribute('aria-live')).toBe('polite');
    expect(status().textContent).toBe('');
  });

  it('announces a settled burst once, with its total and count', () => {
    update(-120);
    update(-30);
    expect(status().textContent).toBe('');

    settle();

    expect(status().textContent).toBe('Spent 150 Buzz in 2 transactions.');
  });

  it('announces a gain as received', () => {
    update(250);
    settle();

    expect(status().textContent).toBe('Received 250 Buzz.');
  });

  it('announces a second group with identical text by replacing the node', () => {
    update(-50);
    settle();
    const first = status().firstElementChild;

    update(-50);
    settle();

    expect(status().textContent).toBe('Spent 50 Buzz.');
    expect(status().firstElementChild).not.toBe(first);
  });
});
