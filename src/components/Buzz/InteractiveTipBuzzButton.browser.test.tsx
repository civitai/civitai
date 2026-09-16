import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as Notifications from '@mantine/notifications';
import type * as TrackUtils from '../TrackView/track.utils';
import type * as UseBuzz from '~/components/Buzz/useBuzz';
import type * as BuzzUtils from './buzz.utils';

// CONFIRMATION_TIMEOUT in InteractiveTipBuzzButton.tsx. Not exported, so the two are kept
// in step by hand. `closes on its own` brackets the deadline from both sides, which catches
// a constant moved OUTSIDE roughly [3500, 5400]ms — 5000 -> 4000 passes both halves. The
// bracket is loose on purpose: tightening it trades mutation sensitivity for flake.
const CONFIRMATION_TIMEOUT = 5000;
const WELL_BEFORE_CLOSE = CONFIRMATION_TIMEOUT - 1500;
const PAST_CLOSE = CONFIRMATION_TIMEOUT + 400;

const BALANCE = 500;

let mutationPending = false;
const tipMutate = vi.fn<(vars: { amount: number; toAccountId: number }) => void>(() => {
  mutationPending = true;
});
const conditionalPerform = vi.fn((_amount: number, perform: () => void) => perform());

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ buzz: true, isGreen: false }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, isModerator: false, muted: false }),
}));
vi.mock('~/components/Buzz/useBuzz', async (importOriginal) => ({
  ...(await importOriginal<typeof UseBuzz>()),
  useQueryBuzz: () => ({ data: { total: BALANCE } }),
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
vi.mock('@mantine/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof Notifications>()),
  showNotification: vi.fn(),
}));
vi.mock('../TrackView/track.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof TrackUtils>()),
  useTrackEvent: () => ({ trackAction: vi.fn().mockResolvedValue(undefined) }),
}));
// All five keys of the hook's return are supplied, so a future gate on one of them reads a
// real value here rather than silently taking the undefined branch.
vi.mock('./buzz.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzUtils>()),
  useBuzzTransaction: () => ({
    tipUserMutation: { mutate: tipMutate, isPending: mutationPending },
    conditionalPerformTransaction: conditionalPerform,
    hasRequiredAmount: () => true,
    isLoadingBalance: false,
    canPurchase: true,
  }),
}));

import { InteractiveTipBuzzButton } from './InteractiveTipBuzzButton';
import { renderWithProviders } from '../../../test/component-setup';

const amountField = () => document.querySelector<HTMLElement>('[contenteditable="true"]');

/** Throws rather than returning null, so a test cannot pass having driven nothing. */
const requireAmountField = () => {
  const field = amountField();
  if (!field) throw new Error('tip pop-up is not open — the amount field is not rendered');
  return field;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The confirm timer is armed by the click, not by the assertion that follows it, so waits
// are measured from the click. Otherwise opening cost (~165ms, and worse on a loaded box)
// comes out of the margin the lower bracket below depends on.
let openedAt = 0;
const waitFromOpen = (ms: number) => wait(Math.max(0, ms - (performance.now() - openedAt)));

// Deliberately matches contenteditable="false" too. React renders the attribute either way,
// so the narrow selector above goes null in the 'confirmed' state as well as on close — it
// cannot tell a closed pop-up from one left open and merely uneditable.
const anyAmountField = () => document.querySelector<HTMLElement>('[contenteditable]');

const openTipPopover = async () => {
  renderWithProviders(
    <InteractiveTipBuzzButton toUserId={2} entityId={3} entityType="Image">
      <span>tip</span>
    </InteractiveTipBuzzButton>
  );

  await userEvent.click(page.getByText('tip', { exact: true }));
  openedAt = performance.now();
  await expect.element(page.getByText('Tipping')).toBeInTheDocument();
  return requireAmountField();
};

describe('InteractiveTipBuzzButton', () => {
  beforeEach(() => {
    mutationPending = false;
    tipMutate.mockClear();
    conditionalPerform.mockClear();
  });

  // Brackets the deadline from both sides. The upper half alone passed with
  // CONFIRMATION_TIMEOUT cut to 1500ms — closing EARLY is the regression that matches
  // the bug being fixed, so the lower half is the half that matters.
  test('closes on its own after the confirmation timeout, and not before', async () => {
    await openTipPopover();

    await waitFromOpen(WELL_BEFORE_CLOSE);
    expect(amountField()).not.toBeNull();

    await waitFromOpen(PAST_CLOSE);
    expect(anyAmountField()).toBeNull();
  });

  test('keeps the pop-up open past the confirmation timeout while the amount field is focused', async () => {
    const field = await openTipPopover();

    field.focus();
    await waitFromOpen(PAST_CLOSE);

    expect(amountField()).not.toBeNull();
  });

  test('re-arms the confirmation timeout once the amount field is blurred again', async () => {
    const field = await openTipPopover();

    field.focus();
    field.blur();
    await wait(PAST_CLOSE);

    expect(anyAmountField()).toBeNull();
  });

  test('Enter in the amount field sends the typed amount', async () => {
    const field = await openTipPopover();
    field.focus();
    field.textContent = '50';

    await userEvent.keyboard('{Enter}');

    expect(tipMutate).toHaveBeenCalledTimes(1);
    expect(tipMutate.mock.calls[0][0]).toMatchObject({ amount: 50, toAccountId: 2 });
    // The balance gate must be asked about the amount actually being sent, not about
    // a stale counter — it is what opens the buy-Buzz modal instead of tipping.
    expect(conditionalPerform).toHaveBeenCalledTimes(1);
    expect(conditionalPerform).toHaveBeenCalledWith(50, expect.any(Function));
  });

  // `textContent` cannot see this: Chromium's default Enter inserts <br>/<div>, which
  // contributes no text, and React rewrites innerHTML from buzzCounter on the next
  // commit anyway. Asserting on the event is the only thing that pins preventDefault.
  test('Enter prevents the contentEditable default that would insert a newline', async () => {
    const field = await openTipPopover();
    field.focus();
    field.textContent = '50';

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    field.dispatchEvent(enter);

    expect(enter.defaultPrevented).toBe(true);
    expect(tipMutate).toHaveBeenCalledTimes(1);
  });

  // The pending bail in sendTip is the ONLY dedup in front of this money path — the
  // on-site tip passes no idempotency key, so the Buzz ledger will not refuse a second
  // charge (buzz.controller.ts, createBuzzTipTransactionHandler).
  test('a second Enter while the tip is in flight does not send a second tip', async () => {
    const field = await openTipPopover();
    field.focus();
    field.textContent = '50';

    await userEvent.keyboard('{Enter}');
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );

    expect(tipMutate).toHaveBeenCalledTimes(1);
  });

  // Justin's call, 2026-09-16: Enter sends what the field SHOWS. processEnteredNumber
  // rewrites an out-of-range entry rather than rejecting it, so sending on the first Enter
  // spends a figure that was never on screen. Do not "simplify" this back into one
  // keystroke without asking him — the friction is the point, not an oversight.
  test('Enter on an over-balance amount shows the clamp instead of spending it', async () => {
    const field = await openTipPopover();
    field.focus();
    field.textContent = String(BALANCE * 10);

    await userEvent.keyboard('{Enter}');

    expect(tipMutate).not.toHaveBeenCalled();
    expect(field.textContent).toBe(String(BALANCE));
  });

  test('a second Enter sends the clamped amount', async () => {
    const field = await openTipPopover();
    field.focus();
    field.textContent = String(BALANCE * 10);

    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('{Enter}');

    expect(tipMutate).toHaveBeenCalledTimes(1);
    expect(tipMutate.mock.calls[0][0]).toMatchObject({ amount: BALANCE });
  });

  // The counter already equals the clamp here, so setBuzzCounter is a same-value no-op and
  // React repaints nothing. Without the direct write the field keeps showing the rejected
  // entry, every Enter compares it against the clamp again, and the tip can never be sent.
  test('re-entering an over-balance amount is still recoverable', async () => {
    const field = await openTipPopover();
    field.focus();
    field.textContent = String(BALANCE * 10);
    await userEvent.keyboard('{Enter}');

    field.textContent = String(BALANCE * 10);
    await userEvent.keyboard('{Enter}');
    expect(tipMutate).not.toHaveBeenCalled();
    expect(field.textContent).toBe(String(BALANCE));

    await userEvent.keyboard('{Enter}');
    expect(tipMutate).toHaveBeenCalledTimes(1);
  });

  test('an IME composition commit does not send a tip', async () => {
    const field = await openTipPopover();
    field.focus();
    field.textContent = '50';

    field.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
        cancelable: true,
      })
    );

    expect(tipMutate).not.toHaveBeenCalled();
  });
});
