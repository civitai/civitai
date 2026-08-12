import { describe, expect, it } from 'vitest';
import type { CommentV2Model } from '~/server/selectors/commentv2.selector';
import type { ReplyThread, ReplyThreadRow } from '~/server/services/commentsv2.reply-threads';
import {
  getChildlessCommentIds,
  groupReplyThreads,
  selectReplyThreadsWithinBudget,
} from '~/server/services/commentsv2.reply-threads';
import { ThreadSort } from '~/server/common/enums';
import { constants } from '~/server/common/constants';

const comment = ({
  id,
  threadId,
  reactionCount = 0,
  pinnedAt = null,
}: {
  id: number;
  threadId: number;
  reactionCount?: number;
  pinnedAt?: Date | null;
}) =>
  ({
    id,
    threadId,
    reactionCount,
    pinnedAt,
    content: `comment ${id}`,
    createdAt: new Date('2026-01-01'),
    nsfw: false,
    tosViolation: false,
    hidden: false,
    user: { id: 1, username: 'someone' },
    reactions: [],
  } as unknown as CommentV2Model);

const thread = (
  id: number,
  commentId: number,
  depth: number,
  commentCount = 1
): ReplyThreadRow => ({
  id,
  commentId,
  locked: false,
  commentCount,
  depth,
});

describe('groupReplyThreads', () => {
  it('buckets comments under the thread that holds them', () => {
    const result = groupReplyThreads({
      threads: [thread(10, 1, 1), thread(11, 2, 1)],
      comments: [
        comment({ id: 100, threadId: 10 }),
        comment({ id: 200, threadId: 11 }),
        comment({ id: 101, threadId: 10 }),
      ],
      hiddenCounts: {},
      sort: ThreadSort.Oldest,
      limit: 5,
    });

    expect(result.map((t) => t.commentId)).toEqual([1, 2]);
    expect(result[0].comments.map((c) => c.id)).toEqual([100, 101]);
    expect(result[1].comments.map((c) => c.id)).toEqual([200]);
  });

  it('returns an empty page for a thread whose comments were all filtered out', () => {
    const result = groupReplyThreads({
      threads: [thread(10, 1, 1)],
      comments: [],
      hiddenCounts: {},
      sort: ThreadSort.Oldest,
      limit: 5,
    });

    expect(result[0].comments).toEqual([]);
    expect(result[0].nextCursor).toBeUndefined();
  });

  it('orders by the requested sort', () => {
    const comments = [
      comment({ id: 1, threadId: 10, reactionCount: 2 }),
      comment({ id: 2, threadId: 10, reactionCount: 9 }),
      comment({ id: 3, threadId: 10, reactionCount: 5 }),
    ];
    const args = { threads: [thread(10, 1, 1)], comments, hiddenCounts: {}, limit: 5 };

    expect(
      groupReplyThreads({ ...args, sort: ThreadSort.Oldest })[0].comments.map((c) => c.id)
    ).toEqual([1, 2, 3]);
    expect(
      groupReplyThreads({ ...args, sort: ThreadSort.Newest })[0].comments.map((c) => c.id)
    ).toEqual([3, 2, 1]);
    expect(
      groupReplyThreads({ ...args, sort: ThreadSort.MostReactions })[0].comments.map((c) => c.id)
    ).toEqual([2, 3, 1]);
  });

  it('puts pinned comments first, newest pin leading, outside the page limit', () => {
    const result = groupReplyThreads({
      threads: [thread(10, 1, 1)],
      comments: [
        comment({ id: 1, threadId: 10 }),
        comment({ id: 2, threadId: 10 }),
        comment({ id: 3, threadId: 10, pinnedAt: new Date('2026-01-01') }),
        comment({ id: 4, threadId: 10, pinnedAt: new Date('2026-02-01') }),
      ],
      hiddenCounts: {},
      sort: ThreadSort.Oldest,
      limit: 2,
    });

    expect(result[0].comments.map((c) => c.id)).toEqual([4, 3, 1, 2]);
  });

  it('sets a cursor only when the page is full', () => {
    const comments = [
      comment({ id: 1, threadId: 10 }),
      comment({ id: 2, threadId: 10 }),
      comment({ id: 3, threadId: 10 }),
    ];

    expect(
      groupReplyThreads({
        threads: [thread(10, 1, 1)],
        comments,
        hiddenCounts: {},
        sort: ThreadSort.Oldest,
        limit: 2,
      })[0]
    ).toMatchObject({ nextCursor: 2 });

    expect(
      groupReplyThreads({
        threads: [thread(10, 1, 1)],
        comments,
        hiddenCounts: {},
        sort: ThreadSort.Oldest,
        limit: 5,
      })[0].nextCursor
    ).toBeUndefined();
  });

  it('carries the metadata the client primes the nested thread caches with', () => {
    const [result] = groupReplyThreads({
      threads: [{ id: 10, commentId: 1, locked: true, commentCount: 7, depth: 3 }],
      comments: [comment({ id: 1, threadId: 10 })],
      hiddenCounts: { 10: 2 },
      sort: ThreadSort.Oldest,
      limit: 5,
    });

    expect(result).toMatchObject({
      id: 10,
      locked: true,
      commentCount: 7,
      depth: 3,
      hiddenCount: 2,
    });
  });
});

describe('selectReplyThreadsWithinBudget', () => {
  it('takes everything when it all fits, and reports the deepest level as complete', () => {
    const rows = [thread(10, 1, 1, 2), thread(11, 2, 1, 3), thread(12, 3, 2, 1)];

    const { selected, completedDepth } = selectReplyThreadsWithinBudget({
      rows,
      limit: 5,
      budget: 40,
    });

    expect(selected.map((t) => t.id)).toEqual([10, 11, 12]);
    expect(completedDepth).toBe(2);
  });

  it('stops at the budget and keeps the selection a shallowest-first prefix', () => {
    const rows = [
      thread(30, 3, 2, 10),
      thread(10, 1, 1, 10),
      thread(11, 2, 1, 10),
      thread(31, 4, 2, 10),
    ];

    const { selected } = selectReplyThreadsWithinBudget({ rows, limit: 5, budget: 12 });

    // Depth 1 first (5 + 5 = 10 spent), then the next thread's 5 would exceed 12.
    expect(selected.map((t) => t.id)).toEqual([10, 11]);
  });

  it('reports only the levels it finished, so a half-taken level is not treated as known', () => {
    const rows = [thread(10, 1, 1, 10), thread(11, 2, 1, 10), thread(30, 3, 2, 10)];

    const { completedDepth } = selectReplyThreadsWithinBudget({ rows, limit: 5, budget: 12 });

    expect(completedDepth).toBe(1);
  });

  it('spends only what a thread will actually render, not its whole comment count', () => {
    const rows = [thread(10, 1, 1, 500), thread(11, 2, 1, 500)];

    const { selected } = selectReplyThreadsWithinBudget({ rows, limit: 5, budget: 10 });

    expect(selected.map((t) => t.id)).toEqual([10, 11]);
  });

  it('takes nothing when the very first thread would blow the budget', () => {
    const rows = [thread(10, 1, 1, 10)];

    expect(selectReplyThreadsWithinBudget({ rows, limit: 5, budget: 2 })).toEqual({
      selected: [],
      completedDepth: 0,
    });
  });
});

describe('getChildlessCommentIds', () => {
  const asThread = (row: ReplyThreadRow, commentIds: number[]): ReplyThread => ({
    ...row,
    hiddenCount: 0,
    comments: commentIds.map((id) => comment({ id, threadId: row.id })),
  });

  it('reports page comments with no thread of their own', () => {
    const rows = [thread(10, 1, 1)];

    expect(
      getChildlessCommentIds({
        pageCommentIds: [1, 2, 3],
        threads: [asThread(rows[0], [100])],
        rows,
        completedDepth: 1,
      })
    ).toEqual([2, 3]);
  });

  it('reports nothing when no level was finished', () => {
    const rows = [thread(10, 1, 1)];

    expect(
      getChildlessCommentIds({
        pageCommentIds: [1, 2, 3],
        threads: [asThread(rows[0], [100])],
        rows,
        completedDepth: 0,
      })
    ).toEqual([]);
  });

  it('walks into the replies of finished levels', () => {
    const rows = [thread(10, 1, 1), thread(20, 100, 2)];
    const threads = [asThread(rows[0], [100, 101]), asThread(rows[1], [200])];

    // 100 has a thread, 101 doesn't. 200 sits a level deeper than the walk reached.
    expect(
      getChildlessCommentIds({ pageCommentIds: [1], threads, rows, completedDepth: 2 })
    ).toEqual([101]);
  });

  it('never answers for a comment past the levels it finished', () => {
    const rows = [thread(10, 1, 1)];
    const threads = [asThread(rows[0], [100, 101])];

    // Depth 1 finished, so the page is answerable — but 100/101 need depth-2 threads nobody
    // looked at, and answering 0 there would hide a real "show replies" button.
    expect(
      getChildlessCommentIds({ pageCommentIds: [1, 2], threads, rows, completedDepth: 1 })
    ).toEqual([2]);
  });

  it('ignores replies trimmed off by the page limit, which never render', () => {
    const rows = [thread(10, 1, 1)];
    // The thread holds 100 and 101, but only 100 came back in the page.
    const threads = [asThread(rows[0], [100])];

    expect(
      getChildlessCommentIds({ pageCommentIds: [1], threads, rows, completedDepth: 2 })
    ).toEqual([100]);
  });
});

describe('constants.comments thread settings', () => {
  const wide = ['article', 'bounty', 'challenge'];
  const narrow = ['image', 'bountyEntry'];

  it('gives full-width surfaces room for deeper threads than the narrow ones', () => {
    for (const entityType of wide) expect(constants.comments.getMaxDepth({ entityType })).toBe(10);
    for (const entityType of narrow) expect(constants.comments.getMaxDepth({ entityType })).toBe(3);
    expect(constants.comments.getMaxDepth({ entityType: 'post' })).toBe(5);
  });

  it('only opens every reply tree on surfaces wide enough for it', () => {
    for (const entityType of wide)
      expect(constants.comments.expandsRepliesByDefault({ entityType })).toBe(true);
    for (const entityType of [...narrow, 'comment', 'post'])
      expect(constants.comments.expandsRepliesByDefault({ entityType })).toBe(false);
  });

  it('keeps both settings on one set of surfaces', () => {
    const deep = constants.comments.getMaxDepth({ entityType: 'article' });
    for (const entityType of [...wide, ...narrow, 'comment', 'post', 'model', 'comicChapter']) {
      expect(constants.comments.expandsRepliesByDefault({ entityType })).toBe(
        constants.comments.getMaxDepth({ entityType }) === deep
      );
    }
  });
});
