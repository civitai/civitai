import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/api/creator-score-grants/[userId]`: the reasons are moderator audit notes, so reaching User Lookup
 * is not enough to read them; the grant permission is required too.
 */

const list = vi.hoisted(() => vi.fn<(...a: unknown[]) => Promise<unknown[]>>(async () => []));
const requireUserIdParam = vi.hoisted(() => vi.fn<(...a: unknown[]) => number>(() => 8675309));

vi.mock('$lib/server/creator-score-grant.service', () => ({ listCreatorScoreGrants: list }));
vi.mock('$lib/server/api-guard', () => ({ requireUserIdParam }));

const { GET } = await import('../../../routes/api/creator-score-grants/[userId]/+server');

const call = (grants: Record<string, boolean>) =>
  GET({ params: { userId: '8675309' }, locals: { grants } } as unknown as Parameters<
    typeof GET
  >[0]);

beforeEach(() => {
  list.mockClear();
  requireUserIdParam.mockClear();
});

describe('GET /api/creator-score-grants/[userId]', () => {
  it('refuses a moderator who can open User Lookup but lacks user.creatorScore.grant', async () => {
    await expect(call({ 'user.membership.code': true })).rejects.toMatchObject({ status: 403 });
    expect(list).not.toHaveBeenCalled();
  });

  it('control: with the grant, lists that account', async () => {
    const res = await call({ 'user.creatorScore.grant': true });
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith(8675309);
  });

  it('is gated on the User Lookup page first', async () => {
    await call({ 'user.creatorScore.grant': true });
    expect(requireUserIdParam).toHaveBeenCalledWith(
      expect.anything(),
      { userId: '8675309' },
      '/retool/user-lookup'
    );
  });
});
