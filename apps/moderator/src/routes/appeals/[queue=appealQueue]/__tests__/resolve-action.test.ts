import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveSiteAppeal } = vi.hoisted(() => ({ resolveSiteAppeal: vi.fn() }));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/site-appeals.service', () => ({
  countSiteAppealQueue: vi.fn(),
  getSiteAppealQueue: vi.fn(),
  resolveSiteAppeal,
}));

const { actions } = await import('../+page.server');

type ActionEvent = Parameters<(typeof actions)['resolve']>[0];
type Refusal = { status: number; data: { error: string; appealId?: number } };

const resolve = (
  queue: string,
  fields: Record<string, string>,
  grants: Record<string, boolean> = {}
) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return actions.resolve({
    params: { queue },
    request: new Request(`http://x/appeals/${queue}`, { method: 'POST', body }),
    locals: { user: { id: 900 }, grants },
  } as unknown as ActionEvent) as Promise<Record<string, unknown>>;
};

const approve = { appealId: '5', status: 'Approved', resolvedReason: 'misclassified' };

beforeEach(() => {
  vi.clearAllMocks();
  resolveSiteAppeal.mockResolvedValue({ ok: true, lifted: [], restored: false });
});

// The page's path is what the grant gates, so the queue it names must be the only category the
// action can decide, and the Ban permission must come from the session's grants.
describe('site appeal ruling action', () => {
  it("decides only the URL's own category", async () => {
    await resolve('articles', approve);
    expect(resolveSiteAppeal).toHaveBeenCalledWith(
      expect.objectContaining({ appealId: 5, category: 'Article', moderatorId: 900 })
    );
  });

  it('may lift a ban only with the Ban permission', async () => {
    await resolve('account', approve);
    expect(resolveSiteAppeal).toHaveBeenLastCalledWith(
      expect.objectContaining({ category: 'Account', canBan: false })
    );
    await resolve('account', approve, { 'user.ban': true });
    expect(resolveSiteAppeal).toHaveBeenLastCalledWith(expect.objectContaining({ canBan: true }));
  });

  it('records the reason, note and message as given', async () => {
    await resolve('other', {
      ...approve,
      status: 'Rejected',
      resolvedReason: 'violation-confirmed',
      internalNotes: 'repeat',
      resolvedMessage: 'Sorry.',
    });
    expect(resolveSiteAppeal).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'Rejected',
        resolvedReason: 'violation-confirmed',
        internalNotes: 'repeat',
        resolvedMessage: 'Sorry.',
      })
    );
  });

  it('refuses a reason that does not belong to the verdict before deciding anything', async () => {
    const result = (await resolve('other', {
      ...approve,
      resolvedReason: 'violation-confirmed',
    })) as unknown as Refusal;
    expect(result.status).toBe(400);
    expect(resolveSiteAppeal).not.toHaveBeenCalled();
  });

  it('answers a conflict with 409 and any other failure with 400', async () => {
    resolveSiteAppeal.mockResolvedValueOnce({ ok: false, error: 'taken', conflict: true });
    expect(((await resolve('other', approve)) as unknown as Refusal).status).toBe(409);
    resolveSiteAppeal.mockResolvedValueOnce({ ok: false, error: 'lift failed' });
    const failed = (await resolve('other', approve)) as unknown as Refusal;
    expect([failed.status, failed.data]).toEqual([400, { error: 'lift failed', appealId: 5 }]);
  });

  it('refuses an unknown queue', async () => {
    expect(((await resolve('images', approve)) as unknown as Refusal).status).toBe(404);
    expect(resolveSiteAppeal).not.toHaveBeenCalled();
  });
});
