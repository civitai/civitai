import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `countReactions` and `removeReactions` are bound to `user.removeReactions` through the REAL
 * `requiresGrant`, so what is pinned is that these actions check this grant, not some neighbour's.
 */
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const { countReactions, removeReactions } = vi.hoisted(() => ({
  countReactions: vi.fn(async () => ({ ok: true as const, counts: { ImageReaction: 2 } })),
  removeReactions: vi.fn(async () => ({
    ok: true as const,
    removed: { ImageReaction: 2 },
    remaining: 0,
  })),
}));
vi.mock('$lib/server/user-actions.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/user-actions.service')>()),
  countReactions,
  removeReactions,
}));

const { actions } = await import('../+page.server');

const TARGET = 8675309;

const formEvent = (grants: Record<string, boolean>, fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  return {
    request: { formData: async () => data },
    locals: { user: { id: 990000007 }, grants },
  } as unknown as Parameters<(typeof actions)['removeReactions']>[0];
};

beforeEach(() => vi.clearAllMocks());

describe('removeReactions action — bound to user.removeReactions', () => {
  it('refuses a moderator holding only the account-deletion grant', async () => {
    const result = await actions.removeReactions(
      formEvent({ 'user.deleteAccount': true }, { userId: String(TARGET), username: 'someone' })
    );
    expect(result).toMatchObject({ status: 403, data: { scope: 'denied' } });
    expect(removeReactions).not.toHaveBeenCalled();
  });

  it('passes the id and confirmation through with the grant', async () => {
    const result = await actions.removeReactions(
      formEvent({ 'user.removeReactions': true }, { userId: String(TARGET), username: 'someone' })
    );
    expect(result).toEqual({
      success: true,
      reactionsRemoved: { ImageReaction: 2 },
      reactionsRemaining: 0,
    });
    expect(removeReactions).toHaveBeenCalledWith({ userId: TARGET, username: 'someone' });
  });
});

describe('countReactions action — bound to user.removeReactions', () => {
  it('refuses without the grant', async () => {
    const result = await actions.countReactions(
      formEvent({ 'user.purge': true }, { userId: String(TARGET) })
    );
    expect(result).toMatchObject({ status: 403, data: { scope: 'denied' } });
    expect(countReactions).not.toHaveBeenCalled();
  });

  it('returns the counts with the grant', async () => {
    const result = await actions.countReactions(
      formEvent({ 'user.removeReactions': true }, { userId: String(TARGET) })
    );
    expect(result).toEqual({ success: true, reactionCounts: { ImageReaction: 2 } });
    expect(countReactions).toHaveBeenCalledWith(TARGET);
  });
});

describe('the actions surface a failure as a failure', () => {
  it('removeReactions: a refused or unconfirmed removal is a 400, never success', async () => {
    removeReactions.mockResolvedValueOnce({ ok: false, error: 'Could not confirm.' } as never);
    const result = await actions.removeReactions(
      formEvent({ 'user.removeReactions': true }, { userId: String(TARGET), username: 'someone' })
    );
    expect(result).toMatchObject({
      status: 400,
      data: { scope: 'reactions', error: 'Could not confirm.' },
    });
  });

  it('countReactions: a failed count is a 400', async () => {
    countReactions.mockResolvedValueOnce({ ok: false, error: 'Count failed.' } as never);
    const result = await actions.countReactions(
      formEvent({ 'user.removeReactions': true }, { userId: String(TARGET) })
    );
    expect(result).toMatchObject({
      status: 400,
      data: { scope: 'reactions', error: 'Count failed.' },
    });
  });

  it('an invalid id never reaches the service', async () => {
    const result = await actions.removeReactions(
      formEvent({ 'user.removeReactions': true }, { userId: 'abc' })
    );
    expect(result).toMatchObject({ status: 400, data: { scope: 'reactions' } });
    expect(removeReactions).not.toHaveBeenCalled();
  });
});
