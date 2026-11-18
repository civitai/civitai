import { count, percent } from './format';

export const rankPill = ({ rank, level }: { rank: string; level: number }) =>
  `${rank} · Lv ${level}`;

export const heartsLeft = ({ smites, maxSmites }: { smites: number; maxSmites: number }) =>
  Math.max(0, maxSmites - smites);

/** Progress toward the next heart back, as the hearts' tooltip and rail say it. */
export const heartBackLine = (heartBack: { done: number; needed: number } | null) =>
  heartBack ? `${heartBack.done} of ${heartBack.needed} right verdicts to win back a heart` : null;

/** The compact count beside the hearts: the rail and the meta row below 1024px, where a tooltip cannot be reached. */
export const heartBackShort = (heartBack: { done: number; needed: number } | null) =>
  heartBack ? `${heartBack.done}/${heartBack.needed}` : null;

/** A toast of close calls only is information, not an alarm; any warning or smite in it keeps the alarm. */
export const noticeTone = (notices: { consequence: string }[]): 'calm' | 'alarm' =>
  notices.length > 0 && notices.every((n) => n.consequence === 'close') ? 'calm' : 'alarm';

export type Watch = {
  votes: number;
  watchSize: number;
  watchDone: boolean;
  bonusGold: number;
  capReached: boolean;
  streak?: number;
  /** Today's gold against the cap; with `goldPerVote`, a vote on its way moves it at once. */
  goldRecorded?: number;
  goldCap?: number;
  /** The gold one vote records now (rank, halved below the accuracy bar). */
  goldPerVote?: number;
};

const capNote = 'Gold cap reached · XP still counts';

/**
 * What the Watch strip says. Before the Watch is done the cap note wins because it explains why gold stopped; once it is
 * done the completed line leads (the streak bonus does not count against the cap) and the cap note moves to `sub`.
 */
export function watchStrip(daily: Watch) {
  const value = Math.min(daily.votes, daily.watchSize);
  const gold = count(daily.bonusGold);
  const note = daily.watchDone
    ? `Watch complete, +${gold} gold streak bonus`
    : daily.capReached
    ? capNote
    : `+${gold} gold at the end`;
  return {
    label: `Today's Watch · ${value} of ${daily.watchSize}`,
    value,
    max: daily.watchSize,
    done: daily.watchDone,
    note,
    sub: daily.watchDone && daily.capReached ? capNote : undefined,
  };
}

/**
 * The Watch (and today's gold) as it will read once `sent` votes still on their way to the server land, so the strip and rail move the
 * moment a vote is cast rather than when the page's data is next read. The vote that completes the Watch moves the streak
 * by one, which is what the server stores in every case (a first Watch, yesterday's kept, a shielded gap, a lapse).
 */
export function withVotesSent<T extends Watch>(daily: T, sent: number, goldSent = sent): T {
  if (sent <= 0) return daily;
  const votes = daily.votes + sent;
  const completes = !daily.watchDone && votes >= daily.watchSize;
  const streak = completes && daily.streak !== undefined ? { streak: daily.streak + 1 } : {};
  // Each vote records its gold at vote time, clamped to the cap, as `creditVote` does on the server.
  const { goldRecorded, goldCap, goldPerVote } = daily;
  const gold =
    goldRecorded !== undefined && goldCap && goldPerVote
      ? (() => {
          const next = Math.min(goldCap, goldRecorded + Math.max(0, goldSent) * goldPerVote);
          return { goldRecorded: next, capReached: next >= goldCap };
        })()
      : {};
  return { ...daily, votes, watchDone: daily.watchDone || completes, ...streak, ...gold };
}

/** Today's gold against the daily cap, for the rail; null for a rank that earns no gold (cap 0). */
export function goldToday({ goldRecorded, goldCap }: { goldRecorded: number; goldCap: number }) {
  if (goldCap <= 0) return null;
  return {
    label: `${count(goldRecorded)} of ${count(goldCap)}`,
    ratio: Math.min(1, goldRecorded / goldCap),
    reached: goldRecorded >= goldCap,
  };
}

/**
 * Votes to add on top of a page's daily: those still in flight, plus those that landed while that same daily object is on
 * screen. The refreshed daily holds a landed vote, so keying it to the object means it is never counted twice in the frame
 * where the new data replaces the old (which rang the Watch bell a vote early).
 */
export type PendingVotes = {
  count: number;
  landed: number;
  landedOn: number | null;
  /** Of `landed`, the votes that count toward the Watch but pay no gold (an item that settled first). */
  goldless?: number;
};

// The daily is named by a number, not held: a Svelte `$state` wraps a plain object assigned into it in a proxy, which is
// never `===` the page's own daily, so a landed vote dropped off the Watch until the refreshed data arrived.
const dailyIds = new WeakMap<object, number>();
let lastDailyId = 0;
const dailyId = (daily: object | null | undefined): number | null => {
  if (daily == null) return null;
  let id = dailyIds.get(daily);
  if (id === undefined) dailyIds.set(daily, (id = ++lastDailyId));
  return id;
};

export const pendingVotes = (sent: PendingVotes, daily: object | null | undefined): number =>
  sent.count + (daily != null && sent.landedOn === dailyId(daily) ? sent.landed : 0);

/** The votes on their way or landed on this daily that still add gold: those that pay none are left out. */
export const pendingGoldVotes = (sent: PendingVotes, daily: object | null | undefined): number =>
  pendingVotes(sent, daily) -
  (daily != null && sent.landedOn === dailyId(daily) ? sent.goldless ?? 0 : 0);

/** Moves one vote from in flight to landed on `daily`, in one step, so the total does not dip. */
export function landVote(
  sent: PendingVotes,
  daily: object | null | undefined,
  { paysGold = true }: { paysGold?: boolean } = {}
): void {
  const id = dailyId(daily);
  const same = id !== null && sent.landedOn === id;
  sent.landed = same ? sent.landed + 1 : 1;
  sent.goldless = (same ? sent.goldless ?? 0 : 0) + (paysGold ? 0 : 1);
  sent.landedOn = id;
  sent.count = Math.max(0, sent.count - 1);
}

/**
 * The daily the header draws: a page's own daily (play, home) with the votes still in flight on top, the same reading the
 * rail gets, or else the layout's copy as it came.
 */
export function headerDaily<T extends Watch, L>(
  pageDaily: T | null | undefined,
  layoutDaily: L,
  sent: number
): T | L {
  return pageDaily ? withVotesSent(pageDaily, sent) : layoutDaily;
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

/**
 * A count of today's activity that only moves forward within a UTC day: each server process caches it for a minute, so a
 * refresh served by another process can read an older, lower count.
 */
export function neverBelowToday(
  seen: { day: string; value: number } | null,
  value: number,
  day: string
): { day: string; value: number } {
  return seen && seen.day === day ? { day, value: Math.max(seen.value, value) } : { day, value };
}
