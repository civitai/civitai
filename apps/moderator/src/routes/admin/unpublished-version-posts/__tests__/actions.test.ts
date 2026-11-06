import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/admin/unpublished-version-posts`: who may act, that the dry run only counts, how the typed count
 * is read, and what a real run is refused for. The selection and the writes are covered against a
 * real database in `unpublished-version-posts.pglite.test.ts`.
 */

const PLAN = { eligible: 3, excluded: {}, byReason: {} };
const svc = vi.hoisted(() => ({
  planEnqueue: vi.fn(),
  enqueueUnpublishedVersionPosts: vi.fn(),
}));
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/unpublished-version-posts', () => svc);

const { actions } = await import('../+page.server');
const { parseTypedCount } = await import('$lib/count-input');
const { applyGrants } = await import('$lib/server/access');

const ADMIN = { id: 42, roles: ['moderator:admin'] };
// Holds the reports queue, so a gate moved off /admin to a page this role has would let it through.
const MOD = { id: 7, roles: ['moderator:mod-high-access'] };
applyGrants({ '/reports': ['moderator:mod-high-access'] });

type Action = keyof typeof actions;
const post = (action: Action, fields: Record<string, string>, user: unknown = ADMIN) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  const event = {
    request: { formData: async () => data },
    locals: { user, grants: {} },
  } as unknown as Parameters<(typeof actions)['run']>[0];
  return (actions[action] as (e: typeof event) => Promise<unknown>)(event) as Promise<
    Record<string, unknown>
  >;
};

beforeEach(() => {
  vi.clearAllMocks();
  svc.planEnqueue.mockResolvedValue(PLAN);
  svc.enqueueUnpublishedVersionPosts.mockResolvedValue({ ok: true, reported: 3, plan: PLAN });
});

describe('who may act', () => {
  it.each(['dryRun', 'run'] as const)(
    'refuses %s to a moderator without the admin role',
    async (a) => {
      await expect(post(a, { reasons: 'r', expectedCount: '3' }, MOD)).rejects.toMatchObject({
        status: 403,
      });
      expect(svc.planEnqueue).not.toHaveBeenCalled();
      expect(svc.enqueueUnpublishedVersionPosts).not.toHaveBeenCalled();
    }
  );
});

describe('dry run', () => {
  it('counts, for the de-duplicated reasons as pasted, and files nothing', async () => {
    const res = await post('dryRun', { reasons: ' a \nb, a\n\n' });

    expect(res).toEqual({ kind: 'plan', reasons: ['a', 'b'], plan: PLAN });
    expect(svc.planEnqueue).toHaveBeenCalledWith(['a', 'b']);
    expect(svc.enqueueUnpublishedVersionPosts).not.toHaveBeenCalled();
  });

  it('refuses an empty reason list', async () => {
    // The text comes back as typed, so the box is not wiped by the refusal.
    expect(await post('dryRun', { reasons: ' \n, ' })).toMatchObject({
      status: 400,
      data: { typedReasons: ' \n, ' },
    });
    expect(svc.planEnqueue).not.toHaveBeenCalled();
  });
});

describe('run', () => {
  it('files as the signed-in admin, with the count as typed', async () => {
    const res = await post('run', { reasons: 'a\nb', expectedCount: ' 3 ' });

    expect(res).toEqual({ kind: 'filed', reasons: ['a', 'b'], reported: 3 });
    expect(svc.enqueueUnpublishedVersionPosts).toHaveBeenCalledWith({
      reasons: ['a', 'b'],
      expectedCount: 3,
      moderatorId: 42,
    });
  });

  it.each(['', 'three', '3.027', '-3', '3e3'])(
    'refuses a count typed as %j, before filing anything',
    async (typed) => {
      expect(await post('run', { reasons: 'a', expectedCount: typed })).toMatchObject({
        status: 400,
      });
      expect(svc.enqueueUnpublishedVersionPosts).not.toHaveBeenCalled();
    }
  );

  it('answers 409 with the current plan when the count moved', async () => {
    svc.enqueueUnpublishedVersionPosts.mockResolvedValueOnce({
      ok: false,
      reason: 'countChanged',
      plan: PLAN,
    });

    expect(await post('run', { reasons: 'a', expectedCount: '2' })).toMatchObject({
      status: 409,
      data: { plan: PLAN },
    });
  });

  // Not a success: the green result is shown only for a run whose every page committed.
  it('answers 500 with how many were filed when a page failed', async () => {
    svc.enqueueUnpublishedVersionPosts.mockResolvedValueOnce({
      ok: false,
      reason: 'failed',
      reported: 1,
      plan: PLAN,
    });

    const res = await post('run', { reasons: 'a', expectedCount: '3' });
    expect(res).toMatchObject({ status: 500 });
    expect((res.data as { error: string }).error).toMatch(/after 1 posts were reported/);
  });
});

describe('parseTypedCount', () => {
  it.each([
    ['1,234', 1234],
    ['1 234', 1234],
    ['1_234', 1234],
    ['0', 0],
  ])('reads %j as %i', (typed, n) => {
    expect(parseTypedCount(typed)).toBe(n);
  });

  it.each(['1.234', '1,2a', '', ' ', '+1', '1234567890'])('refuses %j', (typed) => {
    expect(parseTypedCount(typed)).toBeNull();
  });
});
