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

const ENTITY_NOUNS: Record<string, string> = {
  Image: 'images',
  Model: 'models',
  Article: 'articles',
  Post: 'posts',
};

/** "images, models and articles" for the types an event's decoration can be worn on. */
export function describeEntityTypes(types: readonly CosmeticEntity[]) {
  const nouns = types.map((t) => ENTITY_NOUNS[t] ?? t.toLowerCase());
  if (nouns.length <= 1) return nouns.join('');
  return `${nouns.slice(0, -1).join(', ')} and ${nouns[nouns.length - 1]}`;
}

/**
 * Whole minutes until a hat may move again; 0 once it can. `cooldownLeftMs` is the server's count
 * when the hats were fetched, and `elapsedMs` how long ago that was on the browser's own clock, so
 * a browser clock that disagrees with the server's cannot lengthen the wait.
 */
export function minutesUntilMovable(cooldownLeftMs: number, elapsedMs: number) {
  return Math.max(0, Math.ceil((cooldownLeftMs - Math.max(0, elapsedMs)) / 60_000));
}

/** The page's card surface (shop tiles, hat cards, standings rows): a step lighter than the page. */
export const EVENT_CARD_SURFACE = 'bg-white dark:bg-dark-6';

/** The event film as uploaded, so the hero's length and the player read the same file. */
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
