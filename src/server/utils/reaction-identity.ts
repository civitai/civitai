import { HIDDEN_REACTOR_ID } from '~/shared/constants/reaction-privacy.constants';

type ReactionRow = { userId: number; reaction: unknown };

const isReactionRows = (value: unknown): value is ReactionRow[] =>
  Array.isArray(value) &&
  value.every(
    (row) =>
      !!row &&
      typeof row === 'object' &&
      typeof (row as ReactionRow).userId === 'number' &&
      'reaction' in row
  );

/**
 * Every `reactions` array of `{ userId, reaction }` rows anywhere in `value` keeps all of its rows, since clients
 * count them, but only the viewer's own keep their `userId`; the rest get `HIDDEN_REACTOR_ID`. Mutates in place.
 */
export function keepOwnReactorIds(value: unknown, viewerId: number | undefined) {
  const seen = new Set<object>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object' || node instanceof Date || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) return node.forEach(visit);
    for (const [key, child] of Object.entries(node)) {
      if (key === 'reactions' && isReactionRows(child)) {
        for (const row of child) if (row.userId !== viewerId) row.userId = HIDDEN_REACTOR_ID;
      } else visit(child);
    }
  };
  visit(value);
}
