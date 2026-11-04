import { count } from './format';

/**
 * What the header's gold pill and popover print. The pill counts earned plus pending, so it moves the moment a vote
 * earns pending gold; the popover splits the two, and only earned gold is worth Buzz (it is what converts).
 */
export function goldView(
  { goldEarned, goldPending }: { goldEarned: number; goldPending: number },
  goldPerBuzz: number
) {
  return {
    pill: goldEarned + goldPending,
    earned: count(goldEarned),
    pending: count(goldPending),
    buzz: `${count(Math.floor(goldEarned / goldPerBuzz))} Buzz`,
    rate: `${count(goldPerBuzz)} gold = 1 Buzz`,
  };
}
