import { useState } from 'react';
import { pickInitialPriceId } from '~/components/Subscriptions/pickInitialPriceId';

type SelectablePrice = { id: string; currency: string };

/**
 * Which of a membership product's sibling prices a plan card is currently showing, and the
 * setter its currency picker writes to.
 *
 * `pickInitialPriceId` answers "which row should be preselected". The obvious wiring —
 * seeding a `useState` with it — is wrong here, because one of its inputs ARRIVES LATE.
 * `pinnedCurrency` comes from the viewer's existing subscription, which `/pricing` fetches
 * as a plain client query while the plans themselves are prefetched in `getServerSideProps`.
 * So on a hard load the card mounts with the plans already hydrated and the subscription
 * still `undefined`, a `useState` initializer runs exactly once in that state, and the pin
 * can never be applied: the card settles on the USD default and stays there for the whole
 * page life, while the rest of the card re-renders around it and starts offering "Upgrade".
 * The server then substitutes the pinned-currency sibling and charges an amount the card
 * never displayed.
 *
 * So the preselection is DERIVED on every render instead, and state holds only the one thing
 * that genuinely belongs to the component: an explicit choice the user made in the picker.
 * Three properties matter, and each is pinned by a test:
 *
 *  - late inputs land. The moment `pinnedCurrency` (or `defaultPriceId`) resolves, the shown
 *    price follows, in the same render as the rest of the card.
 *  - a warm cache is unchanged. On a client-side navigation the subscription is already in
 *    the react-query cache, so the first render computes the pinned row directly — no
 *    spinner, no remount, no second pass that could flash a different amount.
 *  - an explicit choice sticks. Once the user picks a currency it is never recomputed away,
 *    which is exactly what an effect-based or key-based resync would risk.
 *
 * A selection that is no longer among `prices` is discarded rather than rendered as a blank
 * picker — the product's own prices change when the billing interval toggles.
 */
export function useSelectedPriceId<T extends SelectablePrice>({
  prices,
  defaultPriceId,
  pinnedCurrency,
}: {
  prices: T[];
  defaultPriceId?: string | null;
  pinnedCurrency?: string | null;
}): readonly [string | null, (priceId: string | null) => void] {
  const [chosenPriceId, setChosenPriceId] = useState<string | null>(null);

  const chosen = prices.find((p) => p.id === chosenPriceId);
  const priceId = chosen?.id ?? pickInitialPriceId({ prices, defaultPriceId, pinnedCurrency });

  return [priceId, setChosenPriceId] as const;
}
