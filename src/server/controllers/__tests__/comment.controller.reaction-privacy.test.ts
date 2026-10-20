import { beforeEach, describe, expect, it, vi } from 'vitest';

const svc = vi.hoisted(() => ({
  getComments: vi.fn(),
  getPinnedComments: vi.fn(),
  getCommentById: vi.fn(),
}));

vi.mock('~/server/services/user.service', () => ({
  amIBlockedByUser: vi.fn(async () => false),
  getCosmeticsAndProfilePicturesForUsers: vi.fn(async () => () => ({
    profilePicture: null,
    cosmetics: [],
  })),
}));
vi.mock('~/server/services/blocklist.service', () => ({ throwOnBlockedCommentContent: vi.fn() }));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/rewards', () => ({ reportAcceptedReward: { apply: vi.fn() } }));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: vi.fn() }));
vi.mock('~/server/services/comment.service', () => ({
  ...svc,
  createOrUpdateComment: vi.fn(),
  deleteCommentById: vi.fn(),
  getCommentReactions: vi.fn(),
  toggleHideComment: vi.fn(),
  togglePinComment: vi.fn(),
  updateCommentById: vi.fn(),
  updateCommentReportStatusByReason: vi.fn(),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { getCommentHandler, getCommentsInfiniteHandler } from '../comment.controller';
import {
  HIDDEN_REACTOR_ID,
  HIDE_FROM_REACTION_LISTS_KEY,
} from '~/shared/constants/reaction-privacy.constants';

const VIEWER = 100;
const LISTED = 30;
const HIDDEN = 20;

const reactions = () => [
  { id: 1, reaction: 'Like', user: { id: LISTED, username: 'listed' } },
  { id: 2, reaction: 'Like', user: { id: HIDDEN, username: 'hidden' } },
];
const comment = (id: number) => ({ id, user: { id: 1 }, reactions: reactions(), comments: [] });

beforeEach(() => {
  // The opted-out lookup answers only when asked for the setting key; the reply-count read gets nothing.
  dbMock.dbRead.$queryRaw.mockImplementation((async (
    _s: TemplateStringsArray,
    ...values: unknown[]
  ) => (values.includes(HIDE_FROM_REACTION_LISTS_KEY) ? [{ id: HIDDEN }] : [])) as never);
});

const masked = [
  { id: LISTED, username: 'listed' },
  { id: HIDDEN_REACTOR_ID, username: null },
];

describe('model comment reads mask opted-out reactors and keep the rows', () => {
  it('comment.getAll, pinned and paged comments alike', async () => {
    svc.getComments.mockResolvedValue([comment(1)]);
    svc.getPinnedComments.mockResolvedValue([comment(2)]);

    const { comments } = await getCommentsInfiniteHandler({
      input: { modelId: 1 } as never,
      ctx: { user: { id: VIEWER } } as never,
    });
    expect(comments.map((c) => c.reactions.map((r) => r.user))).toEqual([masked, masked]);
  });

  it('comment.getById, the comment and its replies', async () => {
    svc.getCommentById.mockResolvedValue({ ...comment(1), comments: [comment(2)] });

    const result = await getCommentHandler({
      input: { id: 1 },
      ctx: { user: { id: VIEWER } } as never,
    });
    expect(result.reactions.map((r) => r.user)).toEqual(masked);
    expect(result.comments[0].reactions.map((r) => r.user)).toEqual(masked);
  });
});
