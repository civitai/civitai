import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CommentsV2Service from '~/server/services/commentsv2.service';
import type * as UserPreferences from '~/server/services/user-preferences.service';

// RisingV (2026-11-03): his hat showed in the thread list but not on the same comment opened as the
// root of its reply thread, nor opened from a notification. Both read the comment through getSingle.

const getComment = vi.fn(async () => ({ id: 5, threadId: 1, user: { id: 9, username: 'r' } }));
vi.mock('~/server/services/commentsv2.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CommentsV2Service>()),
  getComment: (...args: unknown[]) => getComment(...(args as [])),
}));
const hat = { cosmeticId: 3311, url: 'twintails.png', until: '2026-12-01T00:00:00.000Z' };
const getShowcaseHatForUser = vi.fn(async (userId: number) => (userId === 9 ? hat : null));
vi.mock('~/server/events/showcase-hat', () => ({
  getShowcaseHatForUser: (userId: number) => getShowcaseHatForUser(userId),
}));
const emptyPreference = { getCached: vi.fn(async () => [] as { id: number }[]) };
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferences>()),
  HiddenUsers: emptyPreference,
  BlockedUsers: emptyPreference,
  BlockedByUsers: emptyPreference,
}));

const { getCommentHandler } = await import('../commentv2.controller');

describe('a comment read on its own (getSingle)', () => {
  beforeEach(() => vi.clearAllMocks());

  it("carries its author's showcase hat, as the thread list does", async () => {
    const comment = await getCommentHandler({
      ctx: { user: { id: 1, isModerator: true } } as never,
      input: { id: 5 } as never,
    });
    expect(comment.user).toEqual({ id: 9, username: 'r', showcaseHat: hat });
    expect(getShowcaseHatForUser).toHaveBeenCalledWith(9);
  });
});
