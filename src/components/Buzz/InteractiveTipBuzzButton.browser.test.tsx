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

// vi.hoisted is the house pattern for a value a vi.mock factory reads (see
// docs/testing/shared-module-mock-migration.md). A plain const also works here, because the
// factory dereferences this at hook-call time rather than while the module body runs.
const { BALANCE } = vi.hoisted(() => ({ BALANCE: 500 }));
// Must stay below BALANCE, or the clamp fires in the tests that are not about clamping and
// they fail as `to be called 1 times, but got 0` — a message that names none of this.
const TYPED_AMOUNT = 50;

let mutationPending = false;
let balanceLoading = false;
const tipMutate = vi.fn<(vars: { amount: number; toAccountId: number }) => void>(() => {
  mutationPending = true;
});
const insufficientFunds = vi.fn();
// Models the DECISION useBuzzTransaction makes — refuse when the amount exceeds the balance —
// not how it announces it. The real hook opens the Buy Buzz modal when the user can purchase,
// and shows "Not enough Buzz" only when they cannot, so this spy stands for "refused", not for
// "toasted". A stub that always performs could not observe a refusal at all.
const conditionalPerform = vi.fn((amount: number, perform: () => void) => {
  if (amount > BALANCE) {
    insufficientFunds();
    return;
  }
  perform();
});

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
vi.mock('~/utils/notifications', () => ({ showErrorNotification: vi.fn() }));
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
    isLoadingBalance: balanceLoading,
    canPurchase: true,
  }),
}));

import { showErrorNotification } from '~/utils/notifications';
import { buzzConstants } from '~/shared/constants/buzz.constants';
import { InteractiveTipBuzzButton } from './InteractiveTipBuzzButton';
import { renderWithProviders } from '../../../test/component-setup';

const amountField = () => document.querySelector<HTMLElement>('[contenteditable="true"]');

/** Throws rather than returning null, so a test cannot pass having driven nothing. */
const requireAmountField = () => {
  const field = amountField();
  if (!field) throw new Error('tip pop-up is not open — the amount field is not rendered');
  return field;
};

const sendButton = () => {
  const icon = document.querySelector('.tabler-icon-send');
  const button = icon?.closest('button');
  if (!button) throw new Error('send icon is not rendered');
  return button;
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
    try {
      localStorage.removeItem('interactive-tip-buzz-tutorial');
    } catch {
      // private mode / blocked storage — the flag only suppresses a mocked notification
    }
    mutationPending = false;
    balanceLoading = false;
    tipMutate.mockClear();
    conditionalPerform.mockClear();
    insufficientFunds.mockClear();
    // Not optional: openTipPopover drives a real click, which fires the first-tip tutorial
    // notification. Without this clear, an assertion that a refusal notified is already
    // satisfied before the act — it was, and it could not fail.
    vi.mocked(showErrorNotification).mockClear();
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
    field.textContent = String(TYPED_AMOUNT);

    await userEvent.keyboard('{Enter}');

    expect(tipMutate).toHaveBeenCalledTimes(1);
    expect(tipMutate.mock.calls[0][0]).toMatchObject({ amount: TYPED_AMOUNT, toAccountId: 2 });
    // The balance gate must be asked about the amount actually being sent, not about
    // a stale counter — it is what opens the buy-Buzz modal instead of tipping.
    expect(conditionalPerform).toHaveBeenCalledTimes(1);
    expect(conditionalPerform).toHaveBeenCalledWith(TYPED_AMOUNT, expect.any(Function));
  });

  // `textContent` cannot see this: Chromium's default Enter inserts <br>/<div>, which
  // contributes no text, and React rewrites innerHTML from buzzCounter on the next
  // commit anyway. Asserting on the event is the only thing that pins preventDefault.
  test('Enter prevents the contentEditable default that would insert a newline', async () => {
    const field = await openTipPopover();
    field.focus();
    field.textContent = String(TYPED_AMOUNT);

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
    field.textContent = String(TYPED_AMOUNT);

    await userEvent.keyboard('{Enter}');
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );

    expect(tipMutate).toHaveBeenCalledTimes(1);
  });

  test('the send icon sends the typed amount in one click', async () => {
    const field = await openTipPopover();
    field.focus();
    field.textContent = String(TYPED_AMOUNT);

    await userEvent.click(sendButton());

    expect(tipMutate).toHaveBeenCalledTimes(1);
    expect(tipMutate.mock.calls[0][0]).toMatchObject({ amount: TYPED_AMOUNT });
  });

  // No pointer-down, so no blur — the case touch devices and some engines actually produce.
  // buzzCounter is still 10 from opening the pop-up; only reading the field sends what the
  // field shows. Without that read this spends 10 while the user is looking at 50.
  test('the send icon sends what the field shows even when no blur fires', async () => {
    const field = await openTipPopover();
    field.textContent = String(TYPED_AMOUNT);

    sendButton().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(tipMutate).toHaveBeenCalledTimes(1);
    expect(tipMutate.mock.calls[0][0]).toMatchObject({ amount: TYPED_AMOUNT });
  });

  test('the send button does not activate from an autorepeating key', async () => {
    await openTipPopover();

    const held = new KeyboardEvent('keydown', {
      key: 'Enter',
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    sendButton().dispatchEvent(held);

    // preventDefault is what stops the browser turning the repeat into a click; the click
    // itself is synthesised by the engine and cannot be observed in this harness.
    expect(held.defaultPrevented).toBe(true);
  });

  // Negative control for the button's repeat guard. Widen it to preventDefault on EVERY key
  // and the icon becomes unreachable by keyboard entirely — a deliberate Enter would do
  // nothing, on the confirm step of a money action.
  test('a deliberate Enter on the focused send button still sends', async () => {
    const field = await openTipPopover();
    field.focus();
    field.textContent = String(TYPED_AMOUNT);
    sendButton().focus();
    expect(document.activeElement).toBe(sendButton());

    await userEvent.keyboard('{Enter}');

    expect(tipMutate).toHaveBeenCalledTimes(1);
    expect(tipMutate.mock.calls[0][0]).toMatchObject({ amount: TYPED_AMOUNT });
  });

  // Justin's ruling, 2026-09-17: REFUSE, never rewrite. Nothing is substituted for what the
  // user typed — an over-balance amount sends nothing and says so, rather than silently
  // becoming the balance. Do not "helpfully" clamp this back without asking him: the clamp is
  // what let one keystroke spend a figure that had never been on screen.
  test('an over-balance amount is refused, and the field is left as typed', async () => {
    const field = await openTipPopover();
    field.focus();
    field.textContent = String(BALANCE * 10);

    await userEvent.keyboard('{Enter}');

    expect(tipMutate).not.toHaveBeenCalled();
    expect(insufficientFunds).toHaveBeenCalledTimes(1);
    expect(requireAmountField().textContent).toBe(String(BALANCE * 10));
  });

  test('an amount over the cap is refused without reaching the balance gate', async () => {
    const field = await openTipPopover();
    field.focus();
    field.textContent = String(buzzConstants.maxTipAmount + 1);

    await userEvent.keyboard('{Enter}');

    expect(tipMutate).not.toHaveBeenCalled();
    expect(conditionalPerform).not.toHaveBeenCalled();
    expect(showErrorNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          message: expect.stringContaining('most you can tip'),
        }),
      })
    );
  });

  test('a non-numeric entry is refused rather than floored to 1', async () => {
    const field = await openTipPopover();
    field.focus();
    field.textContent = 'abc';

    await userEvent.keyboard('{Enter}');

    expect(tipMutate).not.toHaveBeenCalled();
    expect(conditionalPerform).not.toHaveBeenCalled();
    // The ruling is refused OUT LOUD, so the refusal has to say something.
    expect(showErrorNotification).toHaveBeenCalledTimes(1);
  });

  // Restored. A test asserting exactly this was deleted with the clamp machinery, and its own
  // comment warned that a NUMERIC comparison would pass these straight through — which is what
  // the replacement then did. Number() accepts the whole JS numeric grammar, so each of these
  // parses to a sendable integer while the field reads as something else.
  // '050' is deliberately NOT here: it is all digits and reads as fifty to anyone looking at
  // it, so sending 50 is honest. The deleted test lumped it in with the others; these are the
  // entries that genuinely display one figure and would send another.
  test.each(['5e1', '0x32', '+50', '5.0', ' 5 0 '])(
    'refuses %s rather than sending what it parses to',
    async (entry) => {
      const field = await openTipPopover();
      field.focus();
      field.textContent = entry;

      await userEvent.keyboard('{Enter}');

      expect(tipMutate).not.toHaveBeenCalled();
      expect(conditionalPerform).not.toHaveBeenCalled();
    }
  );

  // Rests on React 18 flushing sync-lane work in a MICROTASK rather than at the end of the
  // discrete event dispatch — that is why the second press still sees isPending false. If an
  // upgrade makes that flush synchronous, isPending catches it and this goes quietly green.
  // The field's e.repeat guard is what covers a repeat arriving BEFORE React has re-rendered;
  // after the re-render isPending catches it, which is why deleting e.repeat is invisible to
  // every other test. Dispatched synchronously with no await, so no commit intervenes.
  test('a repeat Enter arriving before the re-render does not send twice', async () => {
    const field = await openTipPopover();
    field.focus();
    field.textContent = String(TYPED_AMOUNT);

    const press = (repeat: boolean) =>
      field.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', repeat, bubbles: true, cancelable: true })
      );
    press(false);
    press(true);

    expect(tipMutate).toHaveBeenCalledTimes(1);
  });

  // conditionalPerformTransaction returns silently while the balance query is in flight, and
  // sendTip clears the countdown before reaching it — so without this guard the press leaves a
  // spendable pop-up open with no timer and no message. Same failure this branch exists to
  // remove, reached from a third direction.
  test('a press while the balance is still loading is refused out loud', async () => {
    balanceLoading = true;
    const field = await openTipPopover();
    field.focus();
    field.textContent = String(TYPED_AMOUNT);

    await userEvent.keyboard('{Enter}');

    expect(tipMutate).not.toHaveBeenCalled();
    expect(conditionalPerform).not.toHaveBeenCalled();
    expect(showErrorNotification).toHaveBeenCalledTimes(1);
  });

  test('an IME composition commit does not send a tip', async () => {
    const field = await openTipPopover();
    field.focus();
    field.textContent = String(TYPED_AMOUNT);

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
