import { count, percent } from './format';

export const rankPill = ({ rank, level }: { rank: string; level: number }) =>
  `${rank} · Lv ${level}`;

export const heartsLeft = ({ smites, maxSmites }: { smites: number; maxSmites: number }) =>
  Math.max(0, maxSmites - smites);

type Watch = {
  votes: number;
  watchSize: number;
  watchDone: boolean;
  bonusGold: number;
  capReached: boolean;
};

/** What the Watch strip says; the cap note wins because it explains why gold stopped. */
export function watchStrip(daily: Watch) {
  const value = Math.min(daily.votes, daily.watchSize);
  const gold = count(daily.bonusGold);
  const note = daily.capReached
    ? 'Gold cap reached · XP still counts'
    : daily.watchDone
    ? `Complete · +${gold} gold earned`
    : `+${gold} gold at the end`;
  return {
    label: `Today's Watch · ${value} of ${daily.watchSize}`,
    value,
    max: daily.watchSize,
    note,
  };
}

type Standing = {
  rank: string;
  level: number;
  exp: number;
  goldEarned: number;
  goldPending: number;
  rating: {
    accuracy: number | null;
    bar: number | null;
    belowBar: boolean;
    graded: number;
    minGraded: number;
  };
  nextRank: {
    rank: string;
    fromLevel: number;
    accuracyBar: number;
    levelsToGo: number;
    levelMet: boolean;
    accuracyMet: boolean;
  } | null;
};

/** "Accuracy 82% · the bar for a Knight is 70%", or null for a rank that has no bar. */
export function accuracyLine({ rank, rating }: Pick<Standing, 'rank' | 'rating'>): string | null {
  if (rating.bar === null) return null;
  if (rating.accuracy === null) {
    return `Accuracy: not yet rated, ${rating.graded}/${rating.minGraded} graded`;
  }
  const line = `Accuracy ${percent(rating.accuracy)} · the bar for a ${rank} is ${percent(
    rating.bar
  )}`;
  return rating.belowBar ? `${line} · below it: reduced weight and gold` : line;
}

export function nextRankLine({ nextRank }: Pick<Standing, 'nextRank'>): string | null {
  if (!nextRank) return null;
  const level = nextRank.levelMet ? ' (reached)' : `, ${nextRank.levelsToGo} to go`;
  const met = nextRank.accuracyMet ? ' (reached)' : '';
  return `Next, ${nextRank.rank}: level ${nextRank.fromLevel}${level} and accuracy of ${percent(
    nextRank.accuracyBar
  )} or more${met}`;
}

/** What "Restart career" takes from this player, for the confirmation. Gold is the only money at stake, never smites. */
export function restartLosses(status: Standing) {
  return [
    { title: 'Your rank', detail: 'You return to Acolyte and begin your apprenticeship again.' },
    {
      title: 'Your level and experience',
      detail: `Level ${status.level} and ${count(status.exp)} XP, back to the start.`,
    },
    {
      title: 'Gold you have not yet converted',
      detail: `${count(status.goldEarned)} earned and ${count(status.goldPending)} still pending.`,
    },
  ];
}

const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five'];

export const smiteHeading = (smites: number) =>
  `${NUMBER_WORDS[smites] ?? smites} ${smites === 1 ? 'smite weighs' : 'smites weigh'} on you.`;
