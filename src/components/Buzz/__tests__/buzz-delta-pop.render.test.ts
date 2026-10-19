// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { BuzzDeltaPop } from '~/components/Buzz/BuzzDeltaPop';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { BUZZ_DELTA_QUIET_MS, useBuzzDeltaStore } from '~/store/buzz-delta.store';

const act = (React as unknown as { act: typeof actType }).act;

let container: HTMLDivElement;
let root: Root;

function render(accountTypes: BuzzSpendType[]) {
  act(() => {
    root.render(React.createElement(BuzzDeltaPop, { accountTypes }));
  });
}

const record = (type: BuzzSpendType, delta: number) =>
  act(() => {
    useBuzzDeltaStore.getState().record(type, delta);
  });

const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

describe('BuzzDeltaPop', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    useBuzzDeltaStore.getState().reset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useBuzzDeltaStore.getState().reset();
    vi.useRealTimers();
  });

  it('shows nothing until something is spent', () => {
    render(['yellow']);

    expect(container.textContent).toBe('');
  });

  it('shows the summed spend of a burst, hidden from assistive tech', () => {
    render(['yellow']);
    record('yellow', -120);
    record('yellow', -30);

    expect(container.textContent).toContain('−');
    expect(container.textContent).toContain('150');
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
  });

  it('sums the accounts the counter shows and ignores the ones it does not', () => {
    render(['blue', 'yellow']);
    record('blue', -40);
    record('yellow', -60);
    record('green', -900);

    expect(container.textContent).toContain('100');
    expect(container.textContent).not.toContain('1,000');
    expect(container.textContent).not.toContain('900');
  });

  it('shows nothing for a spend in an account the counter does not show', () => {
    render(['blue']);
    record('yellow', -500);

    expect(container.textContent).toBe('');
  });

  it('removes itself once the group settles and the exit finishes', () => {
    render(['yellow']);
    record('yellow', -75);

    advance(BUZZ_DELTA_QUIET_MS);
    expect(container.textContent).toContain('75');

    advance(1000);
    expect(container.textContent).toBe('');
  });

  it('shows a gain as +N next to a spend', () => {
    render(['yellow']);
    record('yellow', -30);
    record('yellow', 250);

    expect(container.textContent).toContain('−');
    expect(container.textContent).toContain('+');
    expect(container.textContent).toContain('250');
  });

  it('gives a group that opens during the exit fresh digits that roll up from 0', () => {
    render(['yellow']);
    record('yellow', -300);
    advance(BUZZ_DELTA_QUIET_MS + 100);
    const before = container.querySelector('[aria-hidden] > span');

    record('yellow', -5);
    const after = container.querySelector('[aria-hidden] > span');

    expect(container.textContent).toContain('5');
    expect(after).not.toBe(before);
  });

  it('is not kept alive by spends in accounts it does not show', () => {
    render(['yellow']);
    record('yellow', -50);
    advance(BUZZ_DELTA_QUIET_MS);
    advance(300);
    record('green', -10);
    advance(400);

    expect(container.textContent).toBe('');
  });
});
