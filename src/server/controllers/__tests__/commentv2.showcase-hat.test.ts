import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CommentsV2Service from '~/server/services/commentsv2.service';
import type * as UserPreferences from '~/server/services/user-preferences.service';

// A showcase hat showed in the thread list but not on the same comment opened as the root of its
// reply thread, nor opened from a notification (both read through getSingle), nor on a comment just
// saved, which the client writes back into its caches from upsert's result.

const getComment = vi.fn(async () => ({ id: 5, threadId: 1, user: { id: 9, username: 'r' } }));
const upsertComment = vi.fn(async () => ({ id: 6, nsfw: false, user: { id: 9, username: 'r' } }));
vi.mock('~/server/services/commentsv2.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CommentsV2Service>()),
  getComment: (...args: unknown[]) => getComment(...(args as [])),
  upsertComment: (...args: unknown[]) => upsertComment(...(args as [])),
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

const { getCommentHandler, upsertCommentV2Handler } = await import('../commentv2.controller');

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

describe('a comment just saved (upsert)', () => {
  beforeEach(() => vi.clearAllMocks());

  it("carries its author's showcase hat back to the client caches", async () => {
    const result = await upsertCommentV2Handler({
      ctx: { user: { id: 9, isModerator: true }, track: { comment: vi.fn() } } as never,
      input: { entityType: 'review', entityId: 1, content: 'hi' } as never,
    });
    expect(result.user).toEqual({ id: 9, username: 'r', showcaseHat: hat });
  });
});
