import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/api/user-membership-codes/[userId]`: the codes are bearer credentials, so reaching User Lookup
 * is not enough to read them; the minting grant is required too.
 */

const list = vi.hoisted(() => vi.fn<(...a: unknown[]) => Promise<unknown[]>>(async () => []));
const requireUserIdParam = vi.hoisted(() => vi.fn<(...a: unknown[]) => number>(() => 8675309));

vi.mock('$lib/server/membership-code.service', () => ({ listSupportMembershipCodes: list }));
vi.mock('$lib/server/api-guard', () => ({ requireUserIdParam }));

const { GET } = await import('../../../routes/api/user-membership-codes/[userId]/+server');

const call = (grants: Record<string, boolean>) =>
  GET({ params: { userId: '8675309' }, locals: { grants } } as unknown as Parameters<
    typeof GET
  >[0]);

beforeEach(() => {
  list.mockClear();
  requireUserIdParam.mockClear();
});

describe('GET /api/user-membership-codes/[userId]', () => {
  it('refuses a moderator who can open User Lookup but lacks user.membership.code', async () => {
    await expect(call({})).rejects.toMatchObject({ status: 403 });
    expect(list).not.toHaveBeenCalled();
  });

  it('control: with the grant, lists that account', async () => {
    const res = await call({ 'user.membership.code': true });
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith(8675309);
  });

  it('is gated on the User Lookup page first', async () => {
    await call({ 'user.membership.code': true });
    expect(requireUserIdParam).toHaveBeenCalledWith(
      expect.anything(),
      { userId: '8675309' },
      '/retool/user-lookup'
    );
  });
});
