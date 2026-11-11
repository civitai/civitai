import { count } from './format';

type Perks = { goldMultiplier: number; dailyGoldCap: number };

const times = (n: number) => (n === 0 ? 'None' : `${n}×`);
const cap = (n: number) => (n === 0 ? 'None' : count(n));

/** What a rank-up changes, as the dialog prints it: each perk before and after. Empty when either side is unknown. */
export function rankUpChanges(previous: Perks | undefined, now: Perks | undefined) {
  if (!previous || !now) return [];
  return [
    {
      key: 'gold',
      label: 'Gold multiplier',
      from: times(previous.goldMultiplier),
      to: times(now.goldMultiplier),
    },
    {
      key: 'cap',
      label: 'Daily gold cap',
      from: cap(previous.dailyGoldCap),
      to: cap(now.dailyGoldCap),
    },
  ];
}
