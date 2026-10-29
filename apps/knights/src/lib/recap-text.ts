import type { Recap } from '$lib/server/daily/daily.service';

const count = (n: number) => n.toLocaleString('en-US');

/** "18 of yesterday's 30 judgments were confirmed · accuracy 86% · +1,800 gold earned" */
export function recapLine(recap: Recap): string {
  const noun = recap.cast === 1 ? 'judgment was' : 'judgments were';
  const parts = [
    recap.when === 'yesterday'
      ? `${count(recap.confirmed)} of yesterday's ${count(recap.cast)} ${noun} confirmed`
      : `${count(recap.confirmed)} of your ${count(recap.cast)} ${
          recap.cast === 1 ? 'judgment' : 'judgments'
        } ${recap.when} ${recap.cast === 1 ? 'was' : 'were'} confirmed`,
  ];
  if (recap.accuracy !== null) parts.push(`accuracy ${Math.round(recap.accuracy * 100)}%`);
  parts.push(`+${count(recap.goldEarned)} gold earned`);
  if (recap.pending > 0) parts.push(`${count(recap.pending)} still awaiting a verdict`);
  return parts.join(' · ');
}
