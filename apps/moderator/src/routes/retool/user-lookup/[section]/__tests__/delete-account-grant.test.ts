import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The `deleteAccount` form action is bound to its own permission, `user.deleteAccount`, through the
 * REAL `requiresGrant` — not a mock of it — so what is pinned is that this action checks this grant.
 * `moderator:admin` holds every permission implicitly; anyone else only once it is ticked on `/admin`.
 */
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const { deleteAccount, deleteAccountHold } = vi.hoisted(() => ({
  deleteAccount: vi.fn(async () => ({ ok: true as const })),
  deleteAccountHold: vi.fn<() => Promise<'clear' | 'held' | 'unknown'>>(async () => 'clear'),
}));
vi.mock('$lib/server/user-actions.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/user-actions.service')>()),
  deleteAccount,
  deleteAccountHold,
}));

const { actions, load } = await import('../+page.server');

const TARGET = 8675309;

const formEvent = (grants: Record<string, boolean>, fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  return {
    request: { formData: async () => data },
    locals: { user: { id: 990000007 }, grants },
  } as unknown as Parameters<(typeof actions)['deleteAccount']>[0];
};

beforeEach(() => {
  vi.clearAllMocks();
  deleteAccountHold.mockResolvedValue('clear');
});

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

describe('deleteAccount action — a legal hold', () => {
  const withGrant = () =>
    formEvent(
      { 'user.deleteAccount': true },
      { userId: String(TARGET), username: 'not_a_real_user' }
    );

  it.each([
    ['held', 'Account under legal hold; contact Legal.'],
    ['unknown', "Couldn't check legal hold status; try again."],
  ] as const)('refuses a %s account without calling the deletion', async (hold, error) => {
    deleteAccountHold.mockResolvedValue(hold);

    const result = await actions.deleteAccount(withGrant());

    expect(result).toMatchObject({ status: 400, data: { scope: 'account', error } });
    expect(deleteAccountHold).toHaveBeenCalledWith(TARGET);
    expect(deleteAccount).not.toHaveBeenCalled();
  });
});

describe('load — the hold behind the Delete account button', () => {
  const loadEvent = (
    section: string,
    grants: Record<string, boolean>,
    result: unknown = { identity: { id: TARGET } }
  ) =>
    ({
      params: { section },
      url: new URL('https://moderator.invalid/retool/user-lookup/admin?q=1'),
      locals: { grants },
      parent: async () => ({ result }),
    } as unknown as Parameters<typeof load>[0]);

  it.each(['clear', 'held', 'unknown'] as const)(
    'passes a %s hold through on Admin for someone with the permission',
    async (hold) => {
      deleteAccountHold.mockResolvedValue(hold);
      expect(await load(loadEvent('admin', { 'user.deleteAccount': true }))).toEqual({
        section: 'admin',
        deleteHold: hold,
      });
      expect(deleteAccountHold).toHaveBeenCalledWith(TARGET);
    }
  );

  it('asks nothing when no account was found', async () => {
    expect(await load(loadEvent('admin', { 'user.deleteAccount': true }, null))).toMatchObject({
      deleteHold: null,
    });
    expect(deleteAccountHold).not.toHaveBeenCalled();
  });

  it('does not ask without the permission or off Admin', async () => {
    expect(await load(loadEvent('admin', {}))).toMatchObject({ deleteHold: null });
    expect(await load(loadEvent('basic', { 'user.deleteAccount': true }))).toMatchObject({
      deleteHold: null,
    });
    expect(deleteAccountHold).not.toHaveBeenCalled();
  });
});
