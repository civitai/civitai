import type { CosmeticEntity } from '~/shared/utils/prisma/enums';

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

/** Whole minutes until a hat may move again; 0 once it can. */
export function minutesUntilMovable(movableAt: Date | null, now = new Date()) {
  if (!movableAt) return 0;
  return Math.max(0, Math.ceil((movableAt.getTime() - now.getTime()) / 60_000));
}
