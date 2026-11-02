import { count } from './format';

export const rankPill = ({ rank, level }: { rank: string; level: number }) => `${rank} · Lv ${level}`;

export const heartsLeft = ({ smites, maxSmites }: { smites: number; maxSmites: number }) =>
  Math.max(0, maxSmites - smites);

type Watch = { votes: number; watchSize: number; watchDone: boolean; bonusGold: number; capReached: boolean };

/** What the Watch strip says; the cap note wins because it explains why gold stopped. */
export function watchStrip(daily: Watch) {
  const value = Math.min(daily.votes, daily.watchSize);
  const gold = count(daily.bonusGold);
  const note = daily.capReached
    ? 'Gold cap reached · XP still counts'
    : daily.watchDone
      ? `Complete · +${gold} gold earned`
      : `+${gold} gold at the end`;
  return { label: `Today's Watch · ${value} of ${daily.watchSize}`, value, max: daily.watchSize, note };
}
