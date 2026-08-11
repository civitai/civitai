import { describe, expect, it } from 'vitest';
import type { CommentV2Model } from '~/server/selectors/commentv2.selector';
import type { ReplyThreadRow } from '~/server/services/commentsv2.reply-threads';
import { groupReplyThreads } from '~/server/services/commentsv2.reply-threads';
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

describe('constants.comments thread settings', () => {
  it('gives articles room for deeper threads than the narrow image surface', () => {
    expect(constants.comments.getMaxDepth({ entityType: 'article' })).toBeGreaterThan(
      constants.comments.getMaxDepth({ entityType: 'image' })
    );
    expect(constants.comments.getMaxDepth({ entityType: 'image' })).toBe(3);
    expect(constants.comments.getMaxDepth({ entityType: 'bountyEntry' })).toBe(3);
    expect(constants.comments.getMaxDepth({ entityType: 'post' })).toBe(5);
  });

  it('only opens every reply tree on surfaces wide enough for it', () => {
    expect(constants.comments.expandsRepliesByDefault({ entityType: 'article' })).toBe(true);
    expect(constants.comments.expandsRepliesByDefault({ entityType: 'image' })).toBe(false);
    expect(constants.comments.expandsRepliesByDefault({ entityType: 'comment' })).toBe(false);
  });
});
