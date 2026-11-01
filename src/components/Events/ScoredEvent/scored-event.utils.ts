import type { EdgeUrlProps } from '~/client-utils/edge-url';
import type { CosmeticEntity } from '~/shared/utils/prisma/enums';
import { MediaType } from '~/shared/utils/prisma/enums';

export type TeamHistory = { team: string; scores: { date: Date; score: number }[] };

/**
 * Each team's position (1 = leading) at the end of every scored day. A team with no row for a day
 * keeps its previous total, so a quiet day reads as a flat line rather than a drop to zero. Ties
 * share the better position.
 */
export function teamPositionsOverTime(history: TeamHistory[]) {
  const days = [...new Set(history.flatMap((h) => h.scores.map((s) => s.date.getTime())))].sort(
    (a, b) => a - b
  );
  const totals = new Map<string, number>(history.map((h) => [h.team, 0]));
  const positions = new Map<string, { date: Date; position: number }[]>(
    history.map((h) => [h.team, []])
  );
  for (const day of days) {
    for (const { team, scores } of history) {
      const row = scores.find((s) => s.date.getTime() === day);
      if (row) totals.set(team, row.score);
    }
    for (const { team } of history) {
      const mine = totals.get(team) ?? 0;
      const ahead = [...totals.values()].filter((score) => score > mine).length;
      positions.get(team)!.push({ date: new Date(day), position: ahead + 1 });
    }
  }
  return history.map(({ team }) => ({ team, positions: positions.get(team)! }));
}

export type StandingsPoint = { x: number; y: number };
export type StandingsSeries = { team: string; points: StandingsPoint[] };

/**
 * The chart's series per team: the hourly history, ended at the live total (points) or live rank
 * (positions) stamped `now` while the totals are live, so a line ends at the number beside it.
 * Nothing is added when it would repeat the last history value.
 */
export function buildStandingsSeries({
  mode,
  history,
  teams,
  liveTotals,
  now,
}: {
  mode: 'points' | 'position';
  history: TeamHistory[];
  teams: { team: string; score: number; rank: number }[];
  liveTotals: boolean;
  now: number;
}): StandingsSeries[] {
  const series: StandingsSeries[] =
    mode === 'points'
      ? history.map(({ team, scores }) => ({
          team,
          points: scores.map((s) => ({ x: s.date.getTime(), y: s.score })),
        }))
      : teamPositionsOverTime(history).map(({ team, positions }) => ({
          team,
          points: positions.map((p) => ({ x: p.date.getTime(), y: p.position })),
        }));
  if (!liveTotals) return series;
  return series.map(({ team, points }) => {
    const live = teams.find((t) => t.team === team);
    if (!live) return { team, points };
    const y = mode === 'points' ? live.score : live.rank;
    if (points.at(-1)?.y === y) return { team, points };
    return { team, points: [...points, { x: now, y }] };
  });
}

const ENTITY_NOUNS: Record<string, string> = {
  Image: 'images',
  Model: 'models',
  Article: 'articles',
  Post: 'posts',
};

/** "images, models and articles" for the types an event's decoration can be worn on. */
export function describeEntityTypes(types: readonly CosmeticEntity[]) {
  return joinWithAnd(types.map((t) => ENTITY_NOUNS[t] ?? t.toLowerCase()));
}

export function joinWithAnd(words: readonly string[]) {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * Whole minutes until a hat may move again; 0 once it can. `cooldownLeftMs` is the server's count
 * when the hats were fetched, and `elapsedMs` how long ago that was on the browser's own clock, so
 * a browser clock that disagrees with the server's cannot lengthen the wait.
 */
export function minutesUntilMovable(cooldownLeftMs: number, elapsedMs: number) {
  return Math.max(0, Math.ceil((cooldownLeftMs - Math.max(0, elapsedMs)) / 60_000));
}

const COVER_ASPECT = 4 / 5;
const COVER_MAX_WIDTH = 1200;
const COVER_FALLBACK_WIDTH = 320;

function sizeOf(width: unknown, height: unknown) {
  return typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0
    ? { width, height }
    : undefined;
}

/**
 * The width to ask the image CDN for so a picture still fills a 4:5 card `boxWidth` px wide after
 * `object-cover` crops it. The CDN keeps the source's shape, so a source wider than the card comes
 * back too short at the card's width and is stretched to fill the height: ask for that much more
 * width. The size is the image row's own, else its metadata's; with neither, the old fixed 320.
 * A video is transcoded at the width asked for, so it is not stretched: the extra width would cost
 * far more there than on a still.
 */
export function coverRequestWidth(
  image: {
    type?: unknown;
    width?: unknown;
    height?: unknown;
    metadata?: { width?: unknown; height?: unknown } | null;
  },
  boxWidth: number
) {
  if (image.type === MediaType.video) return boxWidth;
  const size =
    sizeOf(image.width, image.height) ?? sizeOf(image.metadata?.width, image.metadata?.height);
  if (!size) return COVER_FALLBACK_WIDTH;
  const stretch = Math.max(1, size.width / size.height / COVER_ASPECT);
  return Math.min(COVER_MAX_WIDTH, Math.round(boxWidth * stretch));
}

/** The page's card surface (shop tiles, hat cards, standings rows): a step lighter than the page. */
export const EVENT_CARD_SURFACE = 'bg-white dark:bg-dark-6';

/** The event film as uploaded: the file whose length `heroVideo.duration` states. */
export const HERO_VIDEO_OPTIONS = {
  type: MediaType.video,
  original: true,
} satisfies Omit<EdgeUrlProps, 'src'>;

export type ScoredSection = 'standings' | 'hats' | 'shop' | 'topHats' | 'rules';

/**
 * The page's sections below the hero, in the order the viewer needs them: how it works first for a
 * visitor deciding whether to join, their own hats first for a player, the result once it is over.
 */
export function scoredSectionOrder({
  joined,
  ended,
}: {
  joined: boolean;
  ended: boolean;
}): ScoredSection[] {
  if (ended) return ['standings', 'topHats', 'hats'];
  if (joined) return ['hats', 'standings', 'shop', 'topHats', 'rules'];
  return ['rules', 'shop', 'standings', 'topHats'];
}

type Settling = { endDate: Date; finalAt?: Date };

/**
 * Ended, but not yet settled: scores take late data until `finalAt`, and the standings snapshot is
 * hourly, so the result is final only once a snapshot taken after `finalAt` is in.
 */
export function isFinalizing(
  data: Settling,
  standings: { updatedAt: Date } | undefined,
  now: Date
) {
  return (
    data.endDate < now &&
    !!data.finalAt &&
    (now < data.finalAt || (!!standings && standings.updatedAt < data.finalAt))
  );
}

/**
 * The rank-1 team once the result is settled. Ranks are unique, so a tie on points still has one
 * winner, and nothing may announce a result the prize payout contradicts.
 */
export function settledWinner(
  data: Settling,
  standings: { updatedAt: Date; teams: { team: string; rank: number }[] } | undefined,
  now: Date
) {
  if (data.endDate >= now || isFinalizing(data, standings, now)) return undefined;
  return standings?.teams.find((t) => t.rank === 1)?.team;
}

// "0:42", "1:24". The shared formatDuration pads a minute-less length to "00:42".
export function filmLength(seconds: number) {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

export const PLACEABLE_TABS = ['Image', 'Model', 'Article'] as const;
export type PlaceableTab = (typeof PLACEABLE_TABS)[number];
export type PlaceableTabState = { count: number; more: boolean; loaded: boolean };

/**
 * The picker's opening tab: where the hat is now, else the first type with anything in it once
 * every tab has loaded, else the first type the hat can go on.
 */
export function defaultPlaceableTab(
  tabs: readonly PlaceableTab[],
  state: Partial<Record<PlaceableTab, PlaceableTabState>>,
  placedOn?: string | null
): PlaceableTab | undefined {
  const current = tabs.find((t) => t === placedOn);
  if (current) return current;
  if (tabs.every((t) => state[t]?.loaded)) {
    const filled = tabs.find((t) => (state[t]?.count ?? 0) > 0);
    if (filled) return filled;
  }
  return tabs[0];
}

/** "24+" while more can be loaded, "3" when that is all of them, nothing until the first page. */
export function placeableTabCount(state?: PlaceableTabState) {
  if (!state?.loaded) return '';
  return `${state.count}${state.more ? '+' : ''}`;
}
