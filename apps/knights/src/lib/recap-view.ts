import { count } from '$lib/format';
import type { Recap } from '$lib/server/daily/daily.service';

export type RecapStat = {
  key: 'confirmed' | 'missed' | 'undecided' | 'accuracy';
  label: string;
  value: string;
  note: string;
};

export type RecapView = {
  headline: string;
  stats: RecapStat[];
  payout: { gold: string; note: string };
};

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Everything the recap popup prints, from the ledger figures alone. Missed is what settled and went against the player; Undecided is what has no verdict: not settled, or settled with no consensus. */
export function recapView(recap: Recap): RecapView {
  const judgments = plural(recap.cast, 'judgment', 'judgments');
  const were = plural(recap.cast, 'was', 'were');
  const headline =
    recap.when === 'yesterday'
      ? `${count(recap.confirmed)} of yesterday's ${count(
          recap.cast
        )} ${judgments} ${were} confirmed`
      : `${count(recap.confirmed)} of your ${count(recap.cast)} ${judgments} ${
          recap.when
        } ${were} confirmed`;

  const note = [
    `${count(recap.confirmed)} ${plural(recap.confirmed, 'judgment', 'judgments')} confirmed`,
  ];
  if (recap.streakBonus > 0) note.push(`+${count(recap.streakBonus)} streak bonus`);

  return {
    headline,
    stats: [
      { key: 'confirmed', label: 'Confirmed', value: count(recap.confirmed), note: 'paid' },
      {
        key: 'missed',
        label: 'Missed',
        value: count(recap.graded - recap.confirmed),
        note: 'consensus disagreed',
      },
      {
        key: 'undecided',
        label: 'Undecided',
        value: count(recap.pending),
        note: 'no consensus',
      },
      {
        key: 'accuracy',
        label: 'Accuracy',
        value: recap.accuracy === null ? '–' : `${Math.round(recap.accuracy * 100)}%`,
        note: 'of settled votes',
      },
    ],
    payout: { gold: `+${count(recap.goldEarned)} gold earned`, note: note.join(' · ') },
  };
}
