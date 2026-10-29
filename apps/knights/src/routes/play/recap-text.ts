import type { Recap } from '$lib/server/daily/daily.service';

const count = (n: number) => n.toLocaleString('en-US');

/** "18 of yesterday's 30 judgments were confirmed · accuracy 86% · +1,800 gold earned", then "+700 streak bonus" on its own line. */
export function recapLines(recap: Recap): string[] {
  const judgments = recap.cast === 1 ? 'judgment' : 'judgments';
  const were = recap.cast === 1 ? 'was' : 'were';
  const parts = [
    recap.when === 'yesterday'
      ? `${count(recap.confirmed)} of yesterday's ${count(
          recap.cast
        )} ${judgments} ${were} confirmed`
      : `${count(recap.confirmed)} of your ${count(recap.cast)} ${judgments} ${
          recap.when
        } ${were} confirmed`,
  ];
  if (recap.accuracy !== null) parts.push(`accuracy ${Math.round(recap.accuracy * 100)}%`);
  parts.push(`+${count(recap.goldEarned)} gold earned`);
  if (recap.pending > 0) parts.push(`${count(recap.pending)} still awaiting a verdict`);
  const lines = [parts.join(' · ')];
  if (recap.streakBonus > 0) lines.push(`+${count(recap.streakBonus)} streak bonus`);
  return lines;
}
