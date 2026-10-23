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
  it.each([
    ['count', MOD],
    ['release', MOD],
    ['count', null],
    ['release', null],
  ] as const)('refuses a non-admin (%s, %o)', async (action, user) => {
    expect(await run(action, user)).toMatchObject({ status: 403 });
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

  it('counts as a dry run, and shows the count with the holds', async () => {
    releaseHeldUserCsamFlags.mockResolvedValue({
      ok: true,
      dryRun: true,
      count: 2,
      remaining: 1,
      legs: ['ban'],
    });
    expect(await run('count')).toEqual({
      counted: {
        userId: 40,
        approvalRef: '2026-01-31-120000-0123abcd',
        reason: 'cleared on review',
        count: 2,
        legs: ['ban'],
      },
    });
    expect(releaseHeldUserCsamFlags).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 40, dryRun: true, moderatorId: 42 })
    );
  });

  it('says how many still need a verdict, in the singular for one', async () => {
    releaseHeldUserCsamFlags.mockResolvedValue({
      ok: true,
      dryRun: false,
      count: 1,
      remaining: 3,
      legs: ['ban'],
    });
    expect(await run('release')).toEqual({
      released: 'Released 1 flag for user #40. 3 still need a verdict.',
    });
  });

  it.each([
    ['3,771', 3771],
    [' 3 771 ', 3771],
    ['128', 128],
  ])('reads the typed count %j as %i, separators and all', async (typed, expected) => {
    await run('release', ADMIN, { ...FIELDS, expectedCount: typed });
    expect(releaseHeldUserCsamFlags).toHaveBeenCalledWith(
      expect.objectContaining({ expectedCount: expected })
    );
  });

  it.each([
    ['no expected count', { expectedCount: '' }],
    ['a decimal count', { expectedCount: '3.771' }],
    ['a count that is not a number', { expectedCount: 'abc' }],
    ['a zero count', { expectedCount: '0' }],
    ['a malformed approval reference', { approvalRef: 'hub:request:x' }],
    ['no reason', { reason: '  ' }],
    ['an id past int range', { userId: '99999999999' }],
  ])('refuses a release with %s', async (_, patch) => {
    expect(await run('release', ADMIN, { ...FIELDS, ...patch })).toMatchObject({ status: 400 });
    expect(releaseHeldUserCsamFlags).not.toHaveBeenCalled();
  });

  it.each([
    ['not-held', /not held.*CSAM queue/],
    ['changed', /not the number you entered.*Nothing was released/],
    ['unavailable', /no release table.*Nothing was released/],
  ] as const)('explains a %s refusal', async (reason, message) => {
    releaseHeldUserCsamFlags.mockResolvedValue({ ok: false, reason, legs: [] });
    expect(await run('release')).toMatchObject({
      status: 409,
      data: { error: expect.stringMatching(message) },
    });
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
