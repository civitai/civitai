// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import classes from '~/components/User/UserBuzz.module.scss';

const act = (React as unknown as { act: typeof actType }).act;

const balances = { yellow: 0, blue: 0 };

vi.mock('~/components/Buzz/useBuzz', () => ({
  useQueryBuzz: () => ({
    data: {
      accounts: (['blue', 'yellow'] as const).map((type) => ({
        type,
        balance: balances[type],
      })),
      total: balances.yellow + balances.blue,
    },
    isLoading: false,
  }),
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ isGreen: false }),
}));
vi.mock('~/components/Buzz/BuzzDeltaPop', () => ({ BuzzDeltaPop: () => null }));

import { UserBuzz } from '~/components/User/UserBuzz';

let container: HTMLDivElement;
let root: Root;

function render(animated: boolean) {
  act(() => {
    root.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(UserBuzz, { animated, accountTypes: ['blue', 'yellow'] })
      )
    );
  });
}

/** Elements between the rolling digits and the container that clip their background to text. */
function textClippingAncestorsOfDigits() {
  const digits = [...container.querySelectorAll('[data-testid="cnf-digit"]')];
  expect(digits.length).toBeGreaterThan(0);
  const clipping = new Set<Element>();
  for (const digit of digits) {
    for (let el = digit.parentElement; el && el !== container; el = el.parentElement) {
      if (el.classList.contains(classes.withGradient)) clipping.add(el);
    }
  }
  return clipping;
}

describe('UserBuzz gradient', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    expect(classes.withGradient).toBeTruthy();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  // A text-clipped background on an ancestor paints each digit stack's untransformed first row,
  // so every rolled digit shows a "0" behind it.
  it.each([
    { yellow: 10_000_001, blue: 0, suffix: 'm' },
    { yellow: 12_000_000, blue: 345_678, suffix: 'm' },
    { yellow: 20_000, blue: 48_210, suffix: 'k' },
  ])('paints rolled digits $yellow + $blue without a text-clipped ancestor', (row) => {
    balances.yellow = row.yellow;
    balances.blue = row.blue;
    render(true);

    expect(textClippingAncestorsOfDigits().size).toBe(0);
    const suffix = [
      ...container.querySelectorAll(`.${classes.buzzText}.${classes.withGradient}`),
    ].find((el) => el.textContent === row.suffix);
    expect(suffix).toBeDefined();
  });

  it('keeps the text-clipped gradient on the static balance', () => {
    balances.yellow = 12_000_000;
    balances.blue = 345_678;
    render(false);

    const clipped = container.querySelector(`.${classes.buzzText}.${classes.withGradient}`);
    expect(clipped?.textContent).toBe('12.3m');
  });
});
