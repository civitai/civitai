import { count } from './format';

/**
 * What the header's gold pill and popover print. The pill is spendable gold, the figure the shop shows and the only gold
 * worth Buzz; pending gold is in its tooltip and the popover.
 */
export function goldView(
  { goldSpendable, goldPending }: { goldSpendable: number; goldPending: number },
  goldPerBuzz: number
) {
  return {
    pill: goldSpendable,
    title: `${count(goldSpendable)} spendable, ${count(goldPending)} pending`,
    spendable: count(goldSpendable),
    pending: count(goldPending),
    buzz: `${count(Math.floor(goldSpendable / goldPerBuzz))} Buzz`,
    rate: `${count(goldPerBuzz)} gold = 1 Buzz`,
  };
}
