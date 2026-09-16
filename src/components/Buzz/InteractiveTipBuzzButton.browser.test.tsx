import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup } from 'vitest-browser-react';

// CONFIRMATION_TIMEOUT in InteractiveTipBuzzButton.tsx. Not exported, so the two
// are kept in step by hand; a change there fails the auto-close test below.
const CONFIRMATION_TIMEOUT = 5000;
const PAST_TIMEOUT = CONFIRMATION_TIMEOUT + 400;

const tipMutate = vi.fn();

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ buzz: true, isGreen: false }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, isModerator: false, muted: false }),
}));
vi.mock('~/components/Buzz/useBuzz', () => ({
  useQueryBuzz: () => ({ data: { total: 1_000_000 } }),
}));
vi.mock('~/components/Currency/useCurrencyConfig', () => ({
  useBuzzCurrencyConfig: () => ({ color: 'yellow.7' }),
}));
vi.mock('~/components/Currency/CurrencyIcon', () => ({ CurrencyIcon: () => null }));
vi.mock('~/components/Currency/CurrencyBadge', () => ({ CurrencyBadge: () => null }));
vi.mock('~/components/LoginPopover/LoginPopover', () => ({
  LoginPopover: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('~/components/ContainerProvider/useContainerSmallerThan', () => ({
  useContainerSmallerThan: () => false,
}));
vi.mock('@mantine/notifications', () => ({ showNotification: vi.fn() }));
vi.mock('../TrackView/track.utils', () => ({
  useTrackEvent: () => ({ trackAction: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock('./buzz.utils', () => ({
  useBuzzTransaction: () => ({
    tipUserMutation: { mutate: tipMutate, isPending: false },
    conditionalPerformTransaction: (_amount: number, perform: () => void) => perform(),
  }),
}));

import { InteractiveTipBuzzButton } from './InteractiveTipBuzzButton';
import { renderWithProviders } from '../../../test/component-setup';

const amountField = () => document.querySelector<HTMLElement>('[contenteditable]');

const openTipPopover = async () => {
  renderWithProviders(
    <InteractiveTipBuzzButton toUserId={2} entityId={3} entityType="Image">
      <span>tip</span>
    </InteractiveTipBuzzButton>
  );

  await userEvent.click(page.getByText('tip'));
  await expect.element(page.getByText('Tipping')).toBeInTheDocument();
};

describe('InteractiveTipBuzzButton', () => {
  beforeEach(() => tipMutate.mockClear());
  afterEach(() => cleanup());

  // Guards the fix below from over-reaching: the pop-up must still close on its
  // own when the user never touches the amount field.
  test('closes on its own after the confirmation timeout when the amount field is untouched', async () => {
    await openTipPopover();

    await new Promise((resolve) => setTimeout(resolve, PAST_TIMEOUT));

    expect(amountField()).toBeNull();
  });

  test('keeps the pop-up open past the confirmation timeout while the amount field is focused', async () => {
    await openTipPopover();

    amountField()?.focus();
    await new Promise((resolve) => setTimeout(resolve, PAST_TIMEOUT));

    expect(amountField()).not.toBeNull();
  });

  test('re-arms the confirmation timeout once the amount field is blurred again', async () => {
    await openTipPopover();

    const field = amountField();
    field?.focus();
    field?.blur();
    await new Promise((resolve) => setTimeout(resolve, PAST_TIMEOUT));

    expect(amountField()).toBeNull();
  });

  test('Enter in the amount field sends the typed amount instead of inserting a newline', async () => {
    await openTipPopover();

    const field = amountField();
    if (!field) throw new Error('amount field not rendered');
    field.focus();
    field.textContent = '50';
    await userEvent.keyboard('{Enter}');

    expect(tipMutate).toHaveBeenCalledTimes(1);
    expect(tipMutate.mock.calls[0][0]).toMatchObject({ amount: 50, toAccountId: 2 });
    expect(field.textContent).toBe('50');
  });
});
