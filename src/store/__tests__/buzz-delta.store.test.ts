// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BuzzTypes } from '~/shared/constants/buzz.constants';
import {
  BUZZ_DELTA_BIG_HOLD_MS,
  BUZZ_DELTA_QUIET_MS,
  recordBuzzUpdate,
  useBuzzDeltaStore,
} from '~/store/buzz-delta.store';

const state = () => useBuzzDeltaStore.getState();

function setTabVisibility(visibility: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('buzz delta store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state().reset();
  });

  afterEach(() => {
    setTabVisibility('visible');
    state().reset();
    vi.useRealTimers();
  });

  it('coalesces a burst into one group whose total is the sum of the spends', () => {
    const spends = [-120, -35, -400, -5, -250];
    for (const delta of spends) state().record('yellow', delta);

    expect(state().groups['yellow:debit']).toMatchObject({ total: 810, count: 5, big: false });

    vi.advanceTimersByTime(BUZZ_DELTA_QUIET_MS);

    expect(state().groups).toEqual({});
    expect(state().settled).toMatchObject({ direction: 'debit', total: 810, count: 5 });
  });

  it('keeps one group open while spends keep arriving inside the quiet window', () => {
    state().record('yellow', -10);
    vi.advanceTimersByTime(BUZZ_DELTA_QUIET_MS - 100);
    state().record('yellow', -10);
    vi.advanceTimersByTime(BUZZ_DELTA_QUIET_MS - 100);
    state().record('yellow', -10);

    expect(state().groups['yellow:debit']).toMatchObject({ total: 30, count: 3 });
    expect(state().settled).toBeNull();
  });

  it('starts a new group after a gap longer than the quiet window', () => {
    state().record('yellow', -10);
    vi.advanceTimersByTime(BUZZ_DELTA_QUIET_MS);
    const first = state().settled;
    state().record('yellow', -20);
    vi.advanceTimersByTime(BUZZ_DELTA_QUIET_MS);

    expect(first).toMatchObject({ total: 10, count: 1 });
    expect(state().settled).toMatchObject({ total: 20, count: 1 });
    expect(state().settled!.seq).toBeGreaterThan(first!.seq);
  });

  it('holds a group with a large spend open for longer', () => {
    state().record('yellow', -12_500);
    vi.advanceTimersByTime(BUZZ_DELTA_QUIET_MS);

    expect(state().groups['yellow:debit']).toMatchObject({ total: 12_500, big: true });

    vi.advanceTimersByTime(BUZZ_DELTA_BIG_HOLD_MS - BUZZ_DELTA_QUIET_MS);

    expect(state().groups).toEqual({});
    expect(state().settled).toMatchObject({ total: 12_500, big: true });
  });

  it('keeps spends and gains, and different accounts, in separate groups', () => {
    state().record('yellow', -100);
    state().record('yellow', 40);
    state().record('blue', -7);

    expect(Object.keys(state().groups).sort()).toEqual([
      'blue:debit',
      'yellow:credit',
      'yellow:debit',
    ]);
  });

  it('ignores updates for accounts that are not spend accounts, and for unknown ones without throwing', () => {
    recordBuzzUpdate({ accountType: BuzzTypes.toApiType('cashPending'), delta: -500 });
    expect(() => recordBuzzUpdate({ accountType: 'NotARealAccount', delta: -500 })).not.toThrow();

    expect(state().groups).toEqual({});
  });

  it('records a signal for a spend account by its API account type', () => {
    recordBuzzUpdate({ accountType: BuzzTypes.toApiType('yellow'), delta: -75 });

    expect(state().groups['yellow:debit']).toMatchObject({ total: 75, count: 1 });
  });

  it('holds spends that arrive in a hidden tab and shows them as one group when it is visible', () => {
    setTabVisibility('hidden');
    for (const delta of [-100, -200, -300]) state().record('yellow', delta);

    expect(state().groups).toEqual({});

    setTabVisibility('visible');

    expect(state().groups['yellow:debit']).toMatchObject({ total: 600, count: 3 });
  });
});

describe('buzz delta store: large spends and empty updates', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state().reset();
  });

  afterEach(() => {
    state().reset();
    vi.useRealTimers();
  });

  it('keeps the long hold when a small spend follows a large one', () => {
    state().record('yellow', -12_500);
    state().record('yellow', -5);
    vi.advanceTimersByTime(BUZZ_DELTA_QUIET_MS);

    expect(state().groups['yellow:debit']).toMatchObject({ total: 12_505, big: true });
  });

  it('treats exactly 10,000 as large and 9,999 as not', () => {
    state().record('yellow', -9_999);
    state().record('blue', -10_000);

    expect(state().groups['yellow:debit']!.big).toBe(false);
    expect(state().groups['blue:debit']!.big).toBe(true);
  });

  it('ignores an update with no change', () => {
    state().record('yellow', 0);

    expect(state().groups).toEqual({});
  });
});
