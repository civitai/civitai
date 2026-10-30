import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SpendCap from '$lib/server/assistant/spend-cap';
import type * as UsersService from '$lib/server/users.service';

/** Who may change a spend cap, and what reaches the write. The write itself is covered against a real
 *  database in `spend-cap.pglite.test.ts`. */

const { changeSpendCap, grantableRoles, usersByIds } = vi.hoisted(() => ({
  changeSpendCap: vi.fn(),
  grantableRoles: vi.fn(),
  usersByIds: vi.fn(),
}));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/roles', () => ({ NO_ROLE_CATALOGUE: 'no catalogue', grantableRoles }));
vi.mock('$lib/server/users.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UsersService>()),
  usersByIds,
}));
vi.mock('$lib/server/assistant/spend-cap', async (importOriginal) => ({
  ...(await importOriginal<typeof SpendCap>()),
  changeSpendCap,
}));

const { actions, load } = await import('../spend-caps/+page.server');

const ADMIN = { id: 42, roles: ['moderator:admin'] };
const MOD = { id: 7, roles: ['moderator:mod-high-access'] };
const FIELDS = { scope: 'user', subject: '149', usd: '1.00', expect: '', reason: '' };

const request = (fields: Record<string, string>) =>
  ({
    formData: async () => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      return form;
    },
  } as never);

const save = (fields: Record<string, string> = FIELDS, user: unknown = ADMIN) =>
  actions.save({ request: request(fields), locals: { user } } as never);

beforeEach(() => {
  vi.resetAllMocks();
  changeSpendCap.mockResolvedValue({ changed: true });
  grantableRoles.mockResolvedValue(['moderator:mod-high-access']);
  usersByIds.mockImplementation(async (ids: number[]) => new Map(ids.map((id) => [id, {}])));
});

describe('the spend caps page', () => {
  it.each([MOD, null])('refuses a non-admin the save (%o)', async (user) => {
    expect(await save(FIELDS, user)).toMatchObject({ status: 403 });
    expect(changeSpendCap).not.toHaveBeenCalled();
  });

  it('refuses a non-admin the page itself', async () => {
    await expect(load({ locals: { user: MOD } } as never)).rejects.toMatchObject({ status: 403 });
  });

  it('saves a $0 override as a cap of zero, not as no cap', async () => {
    await save({ ...FIELDS, usd: '0' });
    expect(changeSpendCap).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'user', subject: '149', usd: 0, expect: null, actorId: 42 })
    );
  });

  it.each(['-1', '1.005', '1000000', 'abc'])('refuses %s as a cap', async (usd) => {
    expect(await save({ ...FIELDS, usd })).toMatchObject({ status: 400 });
    expect(changeSpendCap).not.toHaveBeenCalled();
  });

  it('refuses a cap on a role the hub does not have, and on a user who does not exist', async () => {
    expect(await save({ ...FIELDS, scope: 'role', subject: 'moderator:invented' })).toMatchObject({
      status: 400,
    });
    usersByIds.mockResolvedValue(new Map());
    expect(await save()).toMatchObject({ status: 400 });
    expect(changeSpendCap).not.toHaveBeenCalled();
  });

  it('accepts a cap on the admin role, which /admin never grants', async () => {
    await save({ ...FIELDS, scope: 'role', subject: 'moderator:admin' });
    expect(changeSpendCap).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'role', subject: 'moderator:admin', usd: 1 })
    );
  });
});
