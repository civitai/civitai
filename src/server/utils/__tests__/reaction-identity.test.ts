import { describe, expect, it } from 'vitest';
import { viewerReactionsSelect } from '~/server/selectors/reaction.selector';
import { keepOwnReactorIds } from '~/server/utils/reaction-identity';
import { HIDDEN_REACTOR_ID } from '~/shared/constants/reaction-privacy.constants';

const VIEWER = 7;
const OTHER = 8;

const rows = () => [
  { userId: VIEWER, reaction: 'Like' },
  { userId: OTHER, reaction: 'Like' },
  { userId: OTHER, reaction: 'Heart' },
];

describe('keepOwnReactorIds', () => {
  it('keeps every row and the viewer’s own id, and replaces everyone else’s', () => {
    const comment = { id: 1, reactions: rows() };
    keepOwnReactorIds(comment, VIEWER);
    expect(comment.reactions).toEqual([
      { userId: VIEWER, reaction: 'Like' },
      { userId: HIDDEN_REACTOR_ID, reaction: 'Like' },
      { userId: HIDDEN_REACTOR_ID, reaction: 'Heart' },
    ]);
  });

  it('reaches nested comments, reply threads and a target comment', () => {
    const page = {
      comments: [{ id: 1, reactions: rows() }],
      targetComment: { id: 2, reactions: rows() },
      replyThreads: { 1: { comments: [{ id: 3, reactions: rows() }] } },
    };
    keepOwnReactorIds(page, VIEWER);
    const ids = [
      ...page.comments[0].reactions,
      ...page.targetComment.reactions,
      ...page.replyThreads[1].comments[0].reactions,
    ].map((r) => r.userId);
    expect(ids).toEqual(Array(3).fill([VIEWER, HIDDEN_REACTOR_ID, HIDDEN_REACTOR_ID]).flat());
  });

  it('replaces every id for a signed-out viewer', () => {
    const comment = { reactions: rows() };
    keepOwnReactorIds(comment, undefined);
    expect(comment.reactions.map((r) => r.userId)).toEqual([
      HIDDEN_REACTOR_ID,
      HIDDEN_REACTOR_ID,
      HIDDEN_REACTOR_ID,
    ]);
  });

  it('leaves the comment author and anything that is not a reaction row alone', () => {
    const comment = {
      user: { id: OTHER },
      userId: OTHER,
      reactions: rows(),
      tags: [{ userId: OTHER }],
    };
    keepOwnReactorIds(comment, VIEWER);
    expect(comment.user.id).toBe(OTHER);
    expect(comment.userId).toBe(OTHER);
    expect(comment.tags).toEqual([{ userId: OTHER }]);
  });
});

describe('viewerReactionsSelect', () => {
  it('selects only the viewer’s rows, and none for a signed-out viewer', () => {
    expect(viewerReactionsSelect(VIEWER)).toMatchObject({ where: { userId: VIEWER } });
    expect(viewerReactionsSelect(VIEWER).take).toBeUndefined();
    expect(viewerReactionsSelect(undefined).take).toBe(0);
  });
});
