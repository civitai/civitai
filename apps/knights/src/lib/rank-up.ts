import { count } from './format';

/** `dailyGoldCap` spans the rank's levels: the cap rises with level, so a rank has a range rather than one value. */
export type RankPerks = {
  voteWeight: number;
  goldMultiplier: number;
  dailyGoldCap: { from: number; to: number };
};

/** What the new rank brings, as the rank-up dialog prints it. Only the new values: what the rank below had is not shown. */
export const rankBenefits = (perks: RankPerks) => [
  { key: 'weight', label: 'Vote weight', value: `${perks.voteWeight}×` },
  { key: 'gold', label: 'Gold multiplier', value: `${perks.goldMultiplier}×` },
  {
    key: 'cap',
    label: 'Daily gold cap',
    value: `${count(perks.dailyGoldCap.from)}–${count(perks.dailyGoldCap.to)}`,
  },
];
