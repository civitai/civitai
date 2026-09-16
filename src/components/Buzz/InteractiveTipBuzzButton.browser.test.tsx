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
// CLAMP_CONFIRM_DELAY in the component. A confirming press sooner than this is refused.
const PAST_CLAMP_DELAY = 600;
// Must stay below BALANCE, or the clamp fires in the tests that are not about clamping and
// they fail as `to be called 1 times, but got 0` — a message that names none of this.
const TYPED_AMOUNT = 50;

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

// Justin's call, 2026-09-16: a tip sends what the field SHOWS. processEnteredNumber rewrites
// an out-of-range entry rather than rejecting it, so spending on the first press spends a
// figure that was never on screen. Both send paths — Enter and the send icon — require a
// second deliberate press once a clamp has moved the amount. Do not "simplify" either back
// into one press without asking him: the friction is the point, not an oversight.
describe('InteractiveTipBuzzButton', () => {
  beforeEach(() => {
    try {
      localStorage.removeItem('interactive-tip-buzz-tutorial');
    } catch {
      // private mode / blocked storage — the flag only suppresses a mocked notification
    }
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

  test('Enter on an over-balance amount shows the clamp instead of spending it', async () => {
    const field = await openTipPopover();
    field.focus();
    field.textContent = String(BALANCE * 10);

    await userEvent.keyboard('{Enter}');

    expect(tipMutate).not.toHaveBeenCalled();
    // Display sanity only. buzzCounter moves 10 -> 500 here, so React repaints the field to
    // the clamp whatever the gate does; the direct write is pinned in the re-entry test.
    expect(requireAmountField().textContent).toBe(String(BALANCE));
  });

  test('a second Enter sends the clamped amount', async () => {
    const field = await openTipPopover();
    field.focus();
    field.textContent = String(BALANCE * 10);

    await userEvent.keyboard('{Enter}');
    expect(tipMutate).not.toHaveBeenCalled();

    await wait(PAST_CLAMP_DELAY);
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
    // Asserted, not assumed: this is the test's PREMISE — the first Enter has to land and
    // move buzzCounter to the clamp, or what follows is just the previous test again.
    // (A dispatched event proves it too, but synchronously: React then repaints AFTER the
    // re-entry below and overwrites it, so the second Enter reads the clamp and sends.)
    await userEvent.keyboard('{Enter}');
    expect(field.textContent).toBe(String(BALANCE));

    field.textContent = String(BALANCE * 10);
    await userEvent.keyboard('{Enter}');
    expect(tipMutate).not.toHaveBeenCalled();
    expect(requireAmountField().textContent).toBe(String(BALANCE));

    await wait(PAST_CLAMP_DELAY);
    await userEvent.keyboard('{Enter}');
    expect(tipMutate).toHaveBeenCalledTimes(1);
    expect(tipMutate.mock.calls[0][0]).toMatchObject({ amount: BALANCE });
  });

  // The send icon is the OTHER way to spend, and it was the hole: clicking it blurs the
  // field, the blur clamps, and the click closure then spent buzzCounter — the clamped
  // figure — while the user had authorised what was on screen a moment earlier.
  test('the send icon shows the clamp instead of spending it', async () => {
    const field = await openTipPopover();
    field.focus();
    field.textContent = String(BALANCE * 10);

    await userEvent.click(sendButton());

    expect(tipMutate).not.toHaveBeenCalled();
    // Display sanity only, like its Enter twin: buzzCounter moves 10 -> 500, so React
    // repaints to the clamp whatever the gate does. The direct write is pinned in
    // `re-entering an over-balance amount is still recoverable`.
    expect(requireAmountField().textContent).toBe(String(BALANCE));
  });

  test('a second click on the send icon sends the clamped amount', async () => {
    const field = await openTipPopover();
    field.focus();
    field.textContent = String(BALANCE * 10);

    await userEvent.click(sendButton());
    expect(tipMutate).not.toHaveBeenCalled();

    await wait(PAST_CLAMP_DELAY);
    await userEvent.click(sendButton());

    expect(tipMutate).toHaveBeenCalledTimes(1);
    expect(tipMutate.mock.calls[0][0]).toMatchObject({ amount: BALANCE });
  });

  test('the send icon still sends in one click when no clamp was needed', async () => {
    const field = await openTipPopover();
    field.focus();
    field.textContent = String(TYPED_AMOUNT);

    await userEvent.click(sendButton());

    expect(tipMutate).toHaveBeenCalledTimes(1);
    expect(tipMutate.mock.calls[0][0]).toMatchObject({ amount: TYPED_AMOUNT });
  });

  // The gate compares STRINGS. A numeric comparison passes this straight through, because
  // Number('5e1') is exactly the amount that would be sent — and the field does not read as
  // 50 to anyone looking at it. Same class as '050' and '0x32'.
  test('an exponent-form entry shows what it resolves to before it can be sent', async () => {
    const field = await openTipPopover();
    field.focus();
    field.textContent = '5e1';

    await userEvent.keyboard('{Enter}');

    expect(tipMutate).not.toHaveBeenCalled();
    // Display sanity only — see the note in the over-balance test above.
    expect(requireAmountField().textContent).toBe('50');
  });

  // Holding Enter on the FOCUSED SEND BUTTON autorepeats clicks, so the icon path had the
  // same hole `e.repeat` closes for the field. One rule covers both: a press cannot confirm
  // a figure that has not been on screen long enough to read.
  test('a rapid second click does not confirm the clamp', async () => {
    const field = await openTipPopover();
    field.focus();
    field.textContent = String(BALANCE * 10);

    await userEvent.click(sendButton());
    // Dispatched, not driven through userEvent: if this guard regresses the first click
    // sends, the icon goes into its loading state, and userEvent's actionability wait turns
    // a caught regression into a 15s timeout naming nothing instead of a failed assertion.
    sendButton().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(tipMutate).not.toHaveBeenCalled();
  });

  test('a rapid second Enter does not confirm the clamp', async () => {
    const field = await openTipPopover();
    field.focus();
    field.textContent = String(BALANCE * 10);

    await userEvent.keyboard('{Enter}');
    // Dispatched: the gap between two AWAITED presses is wall-clock, and this is the only
    // witness for the field's freshness guard. A loaded box could push the second press
    // outside the 500ms window, where sending is correct — a false red on a money guard.
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );

    expect(tipMutate).not.toHaveBeenCalled();
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

  // The freshness rule only bounds how SOON a confirmation can arrive. A key held past that
  // window still autorepeats, so both of these need their own repeat guard — which is why
  // each waits out CLAMP_CONFIRM_DELAY first. Delete either guard and the hold sends.
  test('an Enter held past the confirm delay still does not confirm its own clamp', async () => {
    const field = await openTipPopover();
    field.focus();
    field.textContent = String(BALANCE * 10);

    await userEvent.keyboard('{Enter}');
    await wait(PAST_CLAMP_DELAY);
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true })
    );

    expect(tipMutate).not.toHaveBeenCalled();
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

  // Pressing the icon is what blurs the field and causes the clamp, so blur-to-click elapsed
  // is the length of the user's own hold. A single press held past CLAMP_CONFIRM_DELAY would
  // otherwise confirm the figure it had just rewritten — the whole balance, on one gesture.
  test('a press held past the confirm delay does not confirm the clamp it caused', async () => {
    const field = await openTipPopover();
    field.focus();
    field.textContent = String(BALANCE * 10);

    const button = sendButton();
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    field.blur();
    await wait(PAST_CLAMP_DELAY);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(tipMutate).not.toHaveBeenCalled();
    expect(requireAmountField().textContent).toBe(String(BALANCE));
  });

  // Negative control for the button's repeat guard. Widen it to preventDefault on EVERY key
  // and the icon becomes unreachable by keyboard entirely — a deliberate Enter would do
  // nothing, on the confirm step of a money action.
  test('a deliberate Enter on the focused send button still sends', async () => {
    const field = await openTipPopover();
    field.focus();
    field.textContent = String(TYPED_AMOUNT);
    sendButton().focus();

    await userEvent.keyboard('{Enter}');

    expect(tipMutate).toHaveBeenCalledTimes(1);
    expect(tipMutate.mock.calls[0][0]).toMatchObject({ amount: TYPED_AMOUNT });
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
