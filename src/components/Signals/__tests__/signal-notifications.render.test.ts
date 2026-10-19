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

const { flags, showBuzzNotification } = vi.hoisted(() => ({
  flags: { buzzSpendPop: true },
  showBuzzNotification: vi.fn(),
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({ useFeatureFlags: () => flags }));
vi.mock('~/components/Buzz/useBuzz', () => ({
  useUserMultipliers: () => ({ multipliers: { globalRewardsBonus: 1 } }),
}));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/notifications')>()),
  showBuzzNotification,
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

function mount(buzzSpendPop: boolean) {
  flags.buzzSpendPop = buzzSpendPop;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(MantineProvider, null, React.createElement(SignalNotifications))
    );
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  showBuzzNotification.mockClear();
  useBuzzDeltaStore.getState().reset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useBuzzDeltaStore.getState().reset();
  vi.useRealTimers();
});

describe('SignalNotifications with buzzSpendPop off', () => {
  beforeEach(() => mount(false));

  it('shows the Buzz update toast and records no spend pop', () => {
    update(-120);
    settle();

    expect(showBuzzNotification).toHaveBeenCalledTimes(1);
    expect(showBuzzNotification.mock.calls[0][0]).toMatchObject({
      title: 'User Buzz Update',
      color: 'yellow.7',
    });
    expect(useBuzzDeltaStore.getState().settled).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});

describe('SignalNotifications with buzzSpendPop on', () => {
  beforeEach(() => mount(true));

  it('records the spend pop and shows no toast', () => {
    update(-120);
    settle();

    expect(useBuzzDeltaStore.getState().settled).toMatchObject({ total: 120, count: 1 });
    expect(showBuzzNotification).not.toHaveBeenCalled();
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
