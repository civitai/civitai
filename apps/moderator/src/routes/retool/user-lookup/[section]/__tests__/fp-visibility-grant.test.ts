import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `fpVisibility` is bound to `user.comments.bulk` through the REAL `requiresGrant`, and hands the
 * service the page's account as the comment's author, so a comment id posted from one account's page
 * can never act on another account's comment.
 */
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const { setFpCommentVisibility } = vi.hoisted(() => ({
  setFpCommentVisibility: vi.fn(async () => ({
    ok: true as const,
    state: null,
    message: 'Hidden on the site now, and on the platform within minutes.',
  })),
}));
vi.mock('$lib/server/fp-comment-visibility.service', () => ({ setFpCommentVisibility }));

const { actions } = await import('../+page.server');

const TARGET = 990100034;
const SEEN_AT = '2026-11-20 01:00:00.123456+00';

const formEvent = (grants: Record<string, boolean>, fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  return {
    request: { formData: async () => data },
    locals: { user: { id: 990000007 }, grants },
  } as unknown as Parameters<(typeof actions)['fpVisibility']>[0];
};

const unhide = {
  userId: String(TARGET),
  commentId: '500',
  hidden: 'false',
  seenVersion: '2',
  seenHiddenAt: SEEN_AT,
};

beforeEach(() => vi.clearAllMocks());

describe('fpVisibility action — bound to user.comments.bulk', () => {
  it('refuses without the grant', async () => {
    const result = await actions.fpVisibility(formEvent({ 'user.purge': true }, unhide));
    expect(result).toMatchObject({ status: 403, data: { scope: 'denied' } });
    expect(setFpCommentVisibility).not.toHaveBeenCalled();
  });

  it("acts only as the page's account's comment, bound to the state on screen", async () => {
    const result = await actions.fpVisibility(formEvent({ 'user.comments.bulk': true }, unhide));
    expect(setFpCommentVisibility).toHaveBeenCalledWith({
      commentId: 500,
      authorId: TARGET,
      hidden: false,
      seen: { version: 2, hiddenAt: SEEN_AT },
    });
    expect(result).toMatchObject({ success: true, fpState: null });
  });

  it('a hide carries no hide time', async () => {
    await actions.fpVisibility(
      formEvent({ 'user.comments.bulk': true }, { ...unhide, hidden: 'true', seenHiddenAt: '' })
    );
    expect(setFpCommentVisibility).toHaveBeenCalledWith(
      expect.objectContaining({ hidden: true, seen: { version: 2, hiddenAt: null } })
    );
  });
});
