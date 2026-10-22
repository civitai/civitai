import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Who may run a release, and what reaches the service. The release itself is covered against a real
 *  database in `csam-flag-release.pglite.test.ts`. */

const { releaseHeldUserCsamFlags } = vi.hoisted(() => ({ releaseHeldUserCsamFlags: vi.fn() }));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/csam-flag-clear', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/csam-flag-clear')>()),
  releaseHeldUserCsamFlags,
}));

const { actions, load } = await import('../csam-flag-release/+page.server');

const ADMIN = { id: 42, roles: ['moderator:admin'] };
const MOD = { id: 7, roles: ['moderator:mod-high-access'] };
const FIELDS = {
  userId: '40',
  approvalRef: '2026-01-31-120000-0123abcd',
  reason: 'cleared on review',
  expectedCount: '2',
};

const request = (fields: Record<string, string>) =>
  ({
    formData: async () => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      return form;
    },
  } as never);

const run = (action: 'count' | 'release', user: unknown = ADMIN, fields = FIELDS) =>
  actions[action]({ request: request(fields), locals: { user } } as never);

beforeEach(() => {
  vi.resetAllMocks();
  releaseHeldUserCsamFlags.mockResolvedValue({
    ok: true,
    dryRun: false,
    count: 2,
    remaining: 0,
    legs: ['ban'],
  });
});

describe('the release page', () => {
  it.each(['count', 'release'] as const)('refuses a non-admin moderator (%s)', async (action) => {
    expect(await run(action, MOD)).toMatchObject({ status: 403 });
    expect(releaseHeldUserCsamFlags).not.toHaveBeenCalled();
  });

  it('refuses a non-admin the page itself', async () => {
    await expect(load({ locals: { user: MOD } } as never)).rejects.toMatchObject({ status: 403 });
  });

  it('control: an admin releases, attributed to themselves, with the count they typed', async () => {
    expect(await run('release')).toEqual({ released: 'Released 2 flags for user #40.' });
    expect(releaseHeldUserCsamFlags).toHaveBeenCalledWith({
      userId: 40,
      approvalRef: '2026-01-31-120000-0123abcd',
      reason: 'cleared on review',
      expectedCount: 2,
      moderatorId: 42,
    });
  });

  it('counts as a dry run', async () => {
    await run('count');
    expect(releaseHeldUserCsamFlags).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 40, dryRun: true, moderatorId: 42 })
    );
  });

  it.each([
    ['no expected count', { expectedCount: '' }],
    ['a malformed approval reference', { approvalRef: 'hub:request:x' }],
    ['no reason', { reason: '  ' }],
    ['an id past int range', { userId: '99999999999' }],
  ])('refuses a release with %s', async (_, patch) => {
    expect(await run('release', ADMIN, { ...FIELDS, ...patch })).toMatchObject({ status: 400 });
    expect(releaseHeldUserCsamFlags).not.toHaveBeenCalled();
  });

  it('says which holds refused, and that nothing changed', async () => {
    releaseHeldUserCsamFlags.mockResolvedValue({
      ok: false,
      reason: 'held',
      legs: ['ban', 'csamReport'],
    });
    expect(await run('release')).toMatchObject({
      status: 409,
      data: { error: expect.stringMatching(/ban, csamReport.*Nothing was released/) },
    });
  });
});
