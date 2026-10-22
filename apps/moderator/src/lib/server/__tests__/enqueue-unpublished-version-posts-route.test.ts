import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `POST /api/admin/enqueue-unpublished-version-posts`: who may call it, that it counts unless told
 * otherwise, and what a real run is refused for. The selection and the writes are covered against a
 * real database in `unpublished-version-posts.pglite.test.ts`.
 */

const PLAN = { eligible: 3, excluded: {}, byReason: {} };
const { planEnqueue, enqueueUnpublishedVersionPosts } = vi.hoisted(() => ({
  planEnqueue: vi.fn(async () => PLAN),
  enqueueUnpublishedVersionPosts: vi.fn(
    async (): Promise<Record<string, unknown>> => ({ ok: true, reported: 3, plan: PLAN })
  ),
}));
vi.mock('$lib/server/unpublished-version-posts', () => ({
  planEnqueue,
  enqueueUnpublishedVersionPosts,
}));

const { POST } = await import(
  '../../../routes/api/admin/enqueue-unpublished-version-posts/+server'
);

const ORIGIN = 'https://moderator.example.test';
const ADMIN = { id: 42, roles: ['moderator:admin'] };
const MOD = { id: 7, roles: ['moderator:mod-high-access'] };

function call(body: unknown, user: unknown = ADMIN) {
  const url = new URL('/api/admin/enqueue-unpublished-version-posts', ORIGIN);
  const request = new Request(url, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const locals = { user, tokenClient: undefined, grants: {} };
  return POST({ request, url, locals, params: {} } as unknown as Parameters<typeof POST>[0]);
}

const status = async (p: Promise<Response>) => {
  try {
    return (await p).status;
  } catch (e) {
    return (e as { status?: number }).status;
  }
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/admin/enqueue-unpublished-version-posts', () => {
  // The refusal below cannot tell /admin from another page this moderator also lacks, so the gate
  // itself is pinned: filing thousands of reports is a super-admin action.
  it('is gated on the super-only admin page', () => {
    expect(POST.spec.auth).toEqual({ kind: 'session', page: '/admin' });
  });

  it('refuses a moderator without the admin page', async () => {
    expect(await status(call({ reasons: ['r'], dryRun: false, expectedCount: 3 }, MOD))).toBe(403);
    expect(planEnqueue).not.toHaveBeenCalled();
    expect(enqueueUnpublishedVersionPosts).not.toHaveBeenCalled();
  });

  it('counts only, when dryRun is not given', async () => {
    const res = await call({ reasons: ['r'], expectedCount: 3 });

    expect(await res.json()).toEqual({ dryRun: true, plan: PLAN });
    expect(enqueueUnpublishedVersionPosts).not.toHaveBeenCalled();
  });

  it('refuses a real run with no expected count', async () => {
    expect(await status(call({ reasons: ['r'], dryRun: false }))).toBe(400);
    expect(enqueueUnpublishedVersionPosts).not.toHaveBeenCalled();
  });

  it('files as the signed-in admin, with the count it was given', async () => {
    const res = await call({ reasons: ['r'], dryRun: false, expectedCount: 3 });

    expect(await res.json()).toEqual({ dryRun: false, reported: 3, plan: PLAN });
    expect(enqueueUnpublishedVersionPosts).toHaveBeenCalledWith({
      reasons: ['r'],
      expectedCount: 3,
      moderatorId: 42,
    });
  });

  it('answers 409 with the current plan when the count moved', async () => {
    enqueueUnpublishedVersionPosts.mockResolvedValueOnce({
      ok: false,
      reason: 'countChanged',
      plan: PLAN,
    });

    const res = await call({ reasons: ['r'], dryRun: false, expectedCount: 2 });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ plan: PLAN });
  });

  it('answers 500 with how many were filed when a page failed', async () => {
    enqueueUnpublishedVersionPosts.mockResolvedValueOnce({
      ok: false,
      reason: 'failed',
      reported: 1,
      plan: PLAN,
    });

    const res = await call({ reasons: ['r'], dryRun: false, expectedCount: 3 });

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ reported: 1 });
  });
});
