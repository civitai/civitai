import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The `deleteAccount` form action is bound to its own permission, `user.deleteAccount`, through the
 * REAL `requiresGrant` — not a mock of it — so what is pinned is that this action checks this grant.
 * `moderator:admin` holds every permission implicitly; anyone else only once it is ticked on `/admin`.
 */
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const { deleteAccount } = vi.hoisted(() => ({
  deleteAccount: vi.fn(async () => ({ ok: true as const })),
}));
vi.mock('$lib/server/user-actions.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/user-actions.service')>()),
  deleteAccount,
}));

const { actions } = await import('../+page.server');

const TARGET = 8675309;

const formEvent = (grants: Record<string, boolean>, fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  return {
    request: { formData: async () => data },
    locals: { user: { id: 990000007 }, grants },
  } as unknown as Parameters<(typeof actions)['deleteAccount']>[0];
};

beforeEach(() => vi.clearAllMocks());

describe('deleteAccount action — bound to user.deleteAccount', () => {
  it('refuses a moderator without the grant, before reaching the service', async () => {
    const result = await actions.deleteAccount(
      formEvent({ 'user.purge': true }, { userId: String(TARGET), username: 'not_a_real_user' })
    );

    expect(result).toMatchObject({ status: 403, data: { scope: 'denied' } });
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it('passes the confirmation and flags through to the service with the grant', async () => {
    const result = await actions.deleteAccount(
      formEvent(
        { 'user.deleteAccount': true },
        { userId: String(TARGET), username: 'not_a_real_user', removeImages: 'false' }
      )
    );

    expect(result).toEqual({ success: true });
    expect(deleteAccount).toHaveBeenCalledWith({
      userId: TARGET,
      username: 'not_a_real_user',
      removeModels: undefined,
      removeImages: false,
    });
  });
});
