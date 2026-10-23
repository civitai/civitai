// The select-mode moves (Shift ±, Move to day…) previewed before any call: the server's rules,
// applied to what is on screen.
import { getPostScheduleError } from '@civitai/shared/post-scheduling';
import type { PlannerPost } from '../host';
import { moveToDay } from './calendar';
import { isSelectable, moveSetIssues, type PlannedMove } from './posts';

export type ShiftUnit = 'days' | 'hours';

export type ShiftDraft = { amount: number; unit: ShiftUnit };

export function shiftDeltaMinutes({ amount, unit }: ShiftDraft): number {
  return amount * (unit === 'days' ? 1440 : 60);
}

export type MovePreview = {
  moves: PlannedMove[];
  issues: string[];
  from: [Date, Date] | null;
  to: [Date, Date] | null;
};

/** Release posts are never moved in bulk, so they drop out here as they do on the server. */
function movable(posts: PlannerPost[], selectedIds: ReadonlySet<number>, now: Date): PlannerPost[] {
  return posts.filter((post) => selectedIds.has(post.id) && isSelectable(post, now));
}

export function shiftMoves(
  posts: PlannerPost[],
  selectedIds: ReadonlySet<number>,
  deltaMinutes: number,
  now: Date
): PlannedMove[] {
  return movable(posts, selectedIds, now).map((post) => ({
    post,
    when: new Date(new Date(post.publishedAt).getTime() + deltaMinutes * 60_000),
  }));
}

export function moveToDayMoves(
  posts: PlannerPost[],
  selectedIds: ReadonlySet<number>,
  dayKey: string,
  now: Date
): PlannedMove[] {
  return movable(posts, selectedIds, now)
    .map((post) => ({ post, when: moveToDay(new Date(post.publishedAt), dayKey) }))
    .filter(({ post, when }) => when.getTime() !== new Date(post.publishedAt).getTime());
}

export function previewMoves(
  posts: PlannerPost[],
  moves: PlannedMove[],
  range: { dailyLimit: number; minGapMinutes: number } | null,
  now: Date
): MovePreview {
  if (moves.length === 0) return { moves, issues: [], from: null, to: null };
  const refusals = moves.flatMap(({ post, when }) => {
    const refusal = getPostScheduleError({ publishedAt: new Date(post.publishedAt) }, when, now);
    return refusal ? [refusal] : [];
  });
  const issues = [...new Set([...refusals, ...moveSetIssues(posts, moves, range, now)])];
  return {
    moves,
    issues,
    from: span(moves.map(({ post }) => new Date(post.publishedAt))),
    to: span(moves.map(({ when }) => when)),
  };
}

function span(dates: Date[]): [Date, Date] {
  const times = dates.map((d) => d.getTime());
  return [new Date(Math.min(...times)), new Date(Math.max(...times))];
}
