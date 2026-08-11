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
