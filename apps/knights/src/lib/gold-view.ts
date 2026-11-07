import { count } from './format';

/**
 * What the header's gold pill and popover print. The pill counts spendable plus pending gold, so it moves the moment a
 * vote earns pending gold and drops when the shop takes gold; only spendable gold is worth Buzz.
 */
export function goldView(
  { goldSpendable, goldPending }: { goldSpendable: number; goldPending: number },
  goldPerBuzz: number
) {
  return {
    pill: goldSpendable + goldPending,
    spendable: count(goldSpendable),
    pending: count(goldPending),
    buzz: `${count(Math.floor(goldSpendable / goldPerBuzz))} Buzz`,
    rate: `${count(goldPerBuzz)} gold = 1 Buzz`,
  };
}
