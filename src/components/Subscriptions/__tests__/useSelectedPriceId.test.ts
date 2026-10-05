// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';

import { useSelectedPriceId } from '~/components/Subscriptions/useSelectedPriceId';

/**
 * REGRESSION coverage for the plan card settling on a price the customer cannot be charged.
 *
 * Stripe pins a customer to one billing currency and the server substitutes the sibling price
 * in it before charging. `pickInitialPriceId` already computes the right row — its own suite
 * is an invariant guard on that pure rule and says so. What is tested HERE is the wiring,
 * which is where the money leak was: the pin is read off the viewer's subscription, and on
 * `/pricing` that subscription arrives LATE.
 *
 *   - `src/pages/pricing/index.tsx` prefetches `subscriptions.getPlans` in
 *     `getServerSideProps`, so the plans are hydrated on first paint.
 *   - `getUserSubscription` is a plain client query (`memberships.util.ts`), so it is
 *     `undefined` on that first client render.
 *   - `MembershipPlans` gates the grid on `productsLoading` alone, so the card mounts in that
 *     window.
 *
 * Seed the selection into a `useState` initializer and it is computed exactly once, in the
 * only render where the pin is unknowable, and never revisited — the card shows the USD
 * amount for the whole page life while `subscriptions.update` charges the AUD sibling
 * immediately (`billing_cycle_anchor: 'now'`), and `MembershipUpgradeModal` displays no
 * amount in between. The first test below is red against that wiring and green against the
 * derived one.
 */

// React 18.3 exposes `act` on the `react` export, but our @types/react (18.0.14) predates
// that typing. Use the runtime `React.act` and borrow the correctly-typed signature.
const act = (React as unknown as { act: typeof actType }).act;

function renderHook<T>(useCb: () => T) {
  const container = document.createElement('div');
  const root = createRoot(container);
  const ref: { current: T | undefined } = { current: undefined };
  function Probe() {
    ref.current = useCb();
    return null;
  }
  act(() => root.render(React.createElement(Probe)));
  return {
    result: ref,
    rerender: () => act(() => root.render(React.createElement(Probe))),
    unmount: () => act(() => root.unmount()),
  };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

/**
 * One membership product's sibling prices, as `subscriptions.getPlans` ships them. USD first,
 * so an implementation that simply returns the head of the list is indistinguishable from one
 * that returns the USD default — and both are caught by the pinned-currency assertions.
 */
const GOLD_PRICES = [
  { id: 'fixture_gold_first', currency: 'usd' },
  { id: 'fixture_gold_second', currency: 'aud' },
  { id: 'fixture_gold_third', currency: 'eur' },
];
const GOLD_USD = 'fixture_gold_first';
const GOLD_AUD = 'fixture_gold_second';
const GOLD_EUR = 'fixture_gold_third';

describe('useSelectedPriceId — a pin that arrives after mount', () => {
  it('follows the pinned currency once the subscription resolves', () => {
    // The card mounts with the plans hydrated and the subscription query still in flight.
    let pinnedCurrency: string | undefined = undefined;
    const { result, rerender, unmount } = renderHook(() =>
      useSelectedPriceId({ prices: GOLD_PRICES, defaultPriceId: GOLD_USD, pinnedCurrency })
    );

    // Nothing is known about the pin yet, so the product default is the honest answer.
    expect(result.current?.[0]).toBe(GOLD_USD);

    // getUserSubscription answers: this member is billed in AUD.
    pinnedCurrency = 'aud';
    rerender();

    // THE REGRESSION. Computed in a `useState` initializer this is still the USD row, so the
    // card shows an amount that is never the one charged.
    expect(result.current?.[0]).toBe(GOLD_AUD);

    unmount();
  });

  it('follows a defaultPriceId that arrives with the same subscription', () => {
    // On the card for the plan the member already holds, `defaultPriceId` is derived from
    // `subscription.price.id` — so it is `undefined`-shaped in exactly the same window, and a
    // mount-time-only read pins the card to the product default instead of the member's own
    // price row.
    let defaultPriceId = GOLD_USD;
    let pinnedCurrency: string | undefined = undefined;
    const { result, rerender, unmount } = renderHook(() =>
      useSelectedPriceId({ prices: GOLD_PRICES, defaultPriceId, pinnedCurrency })
    );

    expect(result.current?.[0]).toBe(GOLD_USD);

    defaultPriceId = GOLD_EUR;
    pinnedCurrency = 'eur';
    rerender();

    expect(result.current?.[0]).toBe(GOLD_EUR);

    unmount();
  });
});

describe('useSelectedPriceId — a pin already known at mount', () => {
  it('picks the pinned row on the FIRST render, with no second pass', () => {
    // The client-side navigation path: `getUserSubscription` is already in the react-query
    // cache, so the pin is present before the card mounts. This must not regress into a
    // render-then-correct flash.
    const renders: (string | null)[] = [];
    const { rerender, unmount } = renderHook(() => {
      const [priceId] = useSelectedPriceId({
        prices: GOLD_PRICES,
        defaultPriceId: GOLD_USD,
        pinnedCurrency: 'aud',
      });
      renders.push(priceId);
      return priceId;
    });

    expect(renders[0]).toBe(GOLD_AUD);

    rerender();
    // Every render agrees: no value other than the pinned row is ever shown.
    expect(new Set(renders)).toEqual(new Set([GOLD_AUD]));

    unmount();
  });

  it('leaves an unpinned card on the product default', () => {
    // Anonymous visitors and members with no Stripe history: the pre-change behaviour, which
    // the fix must not disturb.
    const { result, rerender, unmount } = renderHook(() =>
      useSelectedPriceId({ prices: GOLD_PRICES, defaultPriceId: GOLD_USD })
    );

    expect(result.current?.[0]).toBe(GOLD_USD);
    rerender();
    expect(result.current?.[0]).toBe(GOLD_USD);

    unmount();
  });
});

describe('useSelectedPriceId — an explicit choice from the currency picker', () => {
  it('survives a pin arriving afterwards', () => {
    // The hazard a `useEffect` resync or a remount-on-key would introduce: recomputing the
    // selection would silently undo a choice the user had already made in the picker.
    let pinnedCurrency: string | undefined = undefined;
    const { result, rerender, unmount } = renderHook(() =>
      useSelectedPriceId({ prices: GOLD_PRICES, defaultPriceId: GOLD_USD, pinnedCurrency })
    );

    act(() => result.current?.[1](GOLD_EUR));
    expect(result.current?.[0]).toBe(GOLD_EUR);

    pinnedCurrency = 'aud';
    rerender();

    expect(result.current?.[0]).toBe(GOLD_EUR);

    unmount();
  });

  it('is discarded when it is no longer one of the product prices', () => {
    // Toggling the billing interval swaps the product's price rows under the card.
    let prices = GOLD_PRICES;
    const { result, rerender, unmount } = renderHook(() =>
      useSelectedPriceId({ prices, defaultPriceId: GOLD_USD, pinnedCurrency: 'aud' })
    );

    act(() => result.current?.[1](GOLD_EUR));
    expect(result.current?.[0]).toBe(GOLD_EUR);

    prices = [
      { id: 'fixture_gold_annual_first', currency: 'usd' },
      { id: 'fixture_gold_annual_second', currency: 'aud' },
    ];
    rerender();

    expect(result.current?.[0]).toBe('fixture_gold_annual_second');

    unmount();
  });
});
