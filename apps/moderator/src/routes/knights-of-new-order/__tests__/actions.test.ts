import { beforeEach, describe, expect, it, vi } from 'vitest';

const { block, clear } = vi.hoisted(() => ({ block: vi.fn(), clear: vi.fn() }));

vi.mock('$lib/server/knights/link-review.service', () => ({
  blockLinkReview: block,
  clearLinkReview: clear,
  getLinkReviews: vi.fn(),
  LINK_REVIEW_LIMIT: 100,
  LINK_REVIEW_STATUSES: ['Pending', 'Blocked', 'Cleared'],
}));
vi.mock('$lib/server/access', () => ({ requireAccess: vi.fn() }));
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

import { actions } from '../+page.server';

const formEvent = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return {
    request: { formData: async () => data },
    locals: { user: { id: 77 } },
    url: new URL('http://localhost/knights-of-new-order'),
  } as never;
};

describe('Knights of New Order review actions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a malformed id without calling the service', async () => {
    const result = await actions.block(formEvent({ id: 'abc' }));
    expect(result).toMatchObject({ status: 400 });
    expect(block).not.toHaveBeenCalled();
  });

  it('passes the acting moderator and surfaces an already-decided item as a conflict', async () => {
    block.mockResolvedValueOnce({ ok: false, error: 'decided' });
    const refused = await actions.block(formEvent({ id: '5' }));
    expect(block).toHaveBeenCalledWith(5, 77);
    expect(refused).toMatchObject({ status: 409, data: { error: 'decided' } });

    clear.mockResolvedValueOnce({ ok: true });
    expect(await actions.clear(formEvent({ id: '5' }))).toEqual({ success: true });
    expect(clear).toHaveBeenCalledWith(5, 77);
  });
});
