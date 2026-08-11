import type { CommentV2Model } from '~/server/selectors/commentv2.selector';
import { ThreadSort } from '~/server/common/enums';

export type ReplyThread = {
  id: number;
  commentId: number;
  locked: boolean;
  /** 1 = replies to a comment on the requested page, and the level of the comment that owns it. */
  depth: number;
  commentCount: number;
  hiddenCount: number;
  comments: CommentV2Model[];
  nextCursor?: number;
};

export type ReplyThreadRow = {
  id: number;
  commentId: number;
  locked: boolean;
  commentCount: number;
  depth: number;
};

/**
 * Picks the reply threads worth opening up front, shallowest first, until `budget` comments are
 * accounted for. A page that opens every thread on a 1k-comment article is what made these pages
 * unresponsive before pagination; the budget is what keeps the batch a page-sized amount of work.
 *
 * Selection stops entirely at the first thread that doesn't fit, so the result is a prefix in
 * (depth, id) order — every selected thread's whole ancestor chain is selected too, and none of
 * them renders under a comment that isn't there.
 *
 * `completedDepth` is the deepest level whose threads were ALL selected, which is exactly the
 * range over which the batch can say a comment has no replies at all.
 */
export function selectReplyThreadsWithinBudget({
  rows,
  limit,
  budget,
}: {
  rows: ReplyThreadRow[];
  limit: number;
  budget: number;
}): { selected: ReplyThreadRow[]; completedDepth: number } {
  const ordered = [...rows].sort((a, b) => a.depth - b.depth || a.id - b.id);
  const selected: ReplyThreadRow[] = [];
  let spent = 0;
  let completedDepth = 0;

  for (const row of ordered) {
    const cost = Math.min(row.commentCount, limit);
    if (spent + cost > budget) return { selected, completedDepth };
    spent += cost;
    selected.push(row);
    completedDepth = row.depth;
  }

  // Every row fit, so every level the query looked at is fully accounted for.
  return { selected, completedDepth: ordered.length ? ordered[ordered.length - 1].depth : 0 };
}

/**
 * Comments the batch can state have no replies, so the client doesn't have to ask per comment.
 * Only levels the selection finished cover this — past `completedDepth` a missing thread means
 * "not looked at", not "no replies", and guessing there would hide a real "show replies" button.
 */
export function getChildlessCommentIds({
  pageCommentIds,
  threads,
  rows,
  completedDepth,
}: {
  pageCommentIds: number[];
  threads: ReplyThread[];
  rows: ReplyThreadRow[];
  completedDepth: number;
}): number[] {
  if (completedDepth < 1) return [];

  const hasReplies = new Set(rows.map((row) => row.commentId));
  const byDepth = new Map<number, ReplyThread[]>();
  for (const thread of threads) {
    const bucket = byDepth.get(thread.depth);
    if (bucket) bucket.push(thread);
    else byDepth.set(thread.depth, [thread]);
  }

  const childless: number[] = [];
  for (let level = 1; level <= completedDepth; level++) {
    // Comments at this level: the requested page at level 1, otherwise whatever the threads one
    // level up actually returned — a comment trimmed off by the page limit never renders.
    const ids =
      level === 1
        ? pageCommentIds
        : (byDepth.get(level - 1) ?? []).flatMap((thread) => thread.comments.map((c) => c.id));

    for (const id of ids) if (!hasReplies.has(id)) childless.push(id);
  }

  return childless;
}

function compareBySort(sort: ThreadSort) {
  return (a: CommentV2Model, b: CommentV2Model) => {
    if (sort === ThreadSort.Newest) return b.id - a.id;
    if (sort === ThreadSort.MostReactions) {
      const diff = (b.reactionCount ?? 0) - (a.reactionCount ?? 0);
      return diff !== 0 ? diff : b.id - a.id;
    }
    return a.id - b.id;
  };
}

/**
 * Shapes a flat batch of nested threads and their comments into per-thread first pages that
 * match what `getCommentsInfinite` would have returned for each thread on its own — pinned
 * first, then `limit` comments in `sort` order, and a cursor when more remain.
 */
export function groupReplyThreads({
  threads,
  comments,
  hiddenCounts,
  sort,
  limit,
}: {
  threads: ReplyThreadRow[];
  comments: CommentV2Model[];
  hiddenCounts: Record<number, number>;
  sort: ThreadSort;
  limit: number;
}): ReplyThread[] {
  const byThread = new Map<number, CommentV2Model[]>();
  for (const comment of comments) {
    const bucket = byThread.get(comment.threadId);
    if (bucket) bucket.push(comment);
    else byThread.set(comment.threadId, [comment]);
  }

  return threads.map((thread) => {
    const all = byThread.get(thread.id) ?? [];
    const pinned = all
      .filter((c) => c.pinnedAt)
      .sort((a, b) => new Date(b.pinnedAt ?? 0).getTime() - new Date(a.pinnedAt ?? 0).getTime());
    const page = all
      .filter((c) => !c.pinnedAt)
      .sort(compareBySort(sort))
      .slice(0, limit);

    return {
      id: thread.id,
      commentId: thread.commentId,
      locked: thread.locked,
      depth: thread.depth,
      commentCount: thread.commentCount,
      hiddenCount: hiddenCounts[thread.id] ?? 0,
      comments: [...pinned, ...page],
      nextCursor: page.length === limit ? page[page.length - 1].id : undefined,
    };
  });
}
