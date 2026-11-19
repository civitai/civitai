import { count } from './format';

type Perks = { goldMultiplier: number };

const times = (n: number) => (n === 0 ? 'None' : `${n}×`);

/** What a rank-up changes, as the dialog prints it: each perk before and after. Empty when either side is unknown. The daily gold cap follows level, not rank, so it is not a rank perk. */
export function rankUpChanges(previous: Perks | undefined, now: Perks | undefined) {
  if (!previous || !now) return [];
  return [
    {
      key: 'gold',
      label: 'Gold multiplier',
      from: times(previous.goldMultiplier),
      to: times(now.goldMultiplier),
    },
  ];
}
