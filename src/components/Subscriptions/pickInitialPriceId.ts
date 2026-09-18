type SelectablePrice = { id: string; currency: string };

/**
 * Which of a membership product's sibling prices a plan card should preselect.
 *
 * A membership Product carries one active price per supported currency, and the card lets
 * the user switch between them. The default is `product.defaultPriceId` (USD) — but Stripe
 * pins a customer to ONE billing currency the first time they are invoiced and that pin is
 * immutable, so for a customer already pinned elsewhere every other currency on the card is
 * an amount they cannot be charged.
 *
 * The server substitutes the correct sibling before it calls Stripe, so a purchase succeeds
 * either way. This exists so the figure on the card is the figure that gets charged —
 * which matters most on the plan-change path, where the charge happens immediately with no
 * Stripe-hosted confirmation screen in between.
 *
 * The only pinned currency we can know client-side is the one on an existing subscription:
 * Stripe accepted that price, so by its own rule it is payable in the customer's currency.
 * `customer.currency` itself is a Stripe-side fact with no representation in our database.
 *
 * Case is normalised on both sides. Stripe's API returns lower-case codes and our Stripe
 * rows follow it, but this component is provider-generic and the other payment provider's
 * rows carry the same currencies in upper case, so a case-sensitive comparison silently
 * matches nothing for those products.
 */
export function pickInitialPriceId<T extends SelectablePrice>({
  prices,
  defaultPriceId,
  pinnedCurrency,
}: {
  prices: T[];
  defaultPriceId?: string | null;
  pinnedCurrency?: string | null;
}): string | null {
  if (prices.length === 0) return null;

  const pinned = pinnedCurrency ? pinnedCurrency.toLowerCase() : undefined;
  const defaultPrice = prices.find((p) => p.id === defaultPriceId);

  // The default wins whenever it is payable, so an active plan keeps its own price rather
  // than being re-matched to some other row in the same currency.
  if (defaultPrice && (!pinned || defaultPrice.currency.toLowerCase() === pinned)) {
    return defaultPrice.id;
  }

  if (pinned) {
    const inPinnedCurrency = prices.find((p) => p.currency.toLowerCase() === pinned);
    if (inPinnedCurrency) return inPinnedCurrency.id;
  }

  // No pin, or nothing sold in it — fall back exactly as before: the product default, then
  // USD, then whatever is first. The server decides what is actually chargeable.
  return (
    defaultPrice?.id ?? prices.find((p) => p.currency.toLowerCase() === 'usd')?.id ?? prices[0].id
  );
}
