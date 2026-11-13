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
  streak?: number;
};

/** What the Watch strip says; the cap note wins because it explains why gold stopped. */
export function watchStrip(daily: Watch) {
  const value = Math.min(daily.votes, daily.watchSize);
  const gold = count(daily.bonusGold);
  const note = daily.capReached
    ? 'Gold cap reached · XP still counts'
    : daily.watchDone
    ? `Watch complete, +${gold} gold streak bonus`
    : `+${gold} gold at the end`;
  return {
    label: `Today's Watch · ${value} of ${daily.watchSize}`,
    value,
    max: daily.watchSize,
    done: daily.watchDone,
    note,
  };
}

/**
 * The Watch as it will read once `sent` votes still on their way to the server land, so the strip and rail move the
 * moment a vote is cast rather than when the page's data is next read. The vote that completes the Watch moves the streak
 * by one, which is what the server stores in every case (a first Watch, yesterday's kept, a shielded gap, a lapse).
 */
export function withVotesSent<T extends Watch>(daily: T, sent: number): T {
  if (sent <= 0) return daily;
  const votes = daily.votes + sent;
  const completes = !daily.watchDone && votes >= daily.watchSize;
  const streak = completes && daily.streak !== undefined ? { streak: daily.streak + 1 } : {};
  return { ...daily, votes, watchDone: daily.watchDone || completes, ...streak };
}

type Standing = {
  rank: string;
  level: number;
  exp: number;
  /** Earned gold not yet converted: the part of a player's gold a restart forfeits. */
  goldUnspent?: number;
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
    minDaysPlayed: number;
    daysPlayed: number;
    daysMet: boolean;
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
  return rating.belowBar ? `${line} · below it: reduced gold` : line;
}

/** "a Knight", "an Acolyte". */
export const withArticle = (word: string): string =>
  `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;

/** The short cue for a player under their own rank's accuracy bar, whose gold is cut (see the Codex); null otherwise. */
export function belowBarCue({ rank, rating }: Pick<Standing, 'rank' | 'rating'>): string | null {
  if (!rating.belowBar || rating.accuracy === null || rating.bar === null) return null;
  return `Below the ${rank} bar (${percent(rating.accuracy)} / ${percent(
    rating.bar
  )}): gold counts half`;
}

export function nextRankLine({ nextRank }: Pick<Standing, 'nextRank'>): string | null {
  if (!nextRank) return null;
  const level = nextRank.levelMet ? ' (reached)' : `, ${nextRank.levelsToGo} to go`;
  const met = nextRank.accuracyMet ? ' (reached)' : '';
  const accuracy = `accuracy of ${percent(nextRank.accuracyBar)} or more${met}`;
  const start = `Next, ${nextRank.rank}: level ${nextRank.fromLevel}${level}`;
  if (nextRank.minDaysPlayed === 0) return `${start} and ${accuracy}`;
  const days = nextRank.daysMet ? ' (reached)' : ` (have ${nextRank.daysPlayed})`;
  return `${start}, ${accuracy} and ${nextRank.minDaysPlayed} days played${days}`;
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
      title: 'Gold you have not yet spent',
      detail: `${count(status.goldUnspent ?? 0)} unspent and ${count(
        status.goldPending
      )} still pending.`,
    },
  ];
}

const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five'];

export const smiteHeading = (smites: number) =>
  `${NUMBER_WORDS[smites] ?? smites} ${smites === 1 ? 'smite weighs' : 'smites weigh'} on you.`;
