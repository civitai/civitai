import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rule } = vi.hoisted(() => ({ rule: vi.fn() }));

vi.mock('$lib/server/knights/inquisitor.service', () => ({
  getInquisitorQueue: vi.fn(),
  INQUISITOR_QUEUE_LIMIT: 100,
  ruleOnInquisitorItem: rule,
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
    url: new URL('http://localhost/knights-of-new-order/inquisitor'),
  } as never;
};

describe('Knights of New Order Inquisitor queue actions', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['a malformed item id', { itemId: 'abc', level: '4' }],
    ['a missing level', { itemId: '5' }],
  ])('rejects %s without ruling', async (_label, fields) => {
    expect(await actions.rule(formEvent(fields))).toMatchObject({ status: 400 });
    expect(rule).not.toHaveBeenCalled();
  });

  it('rules as the acting moderator and shows an already-decided item as a conflict', async () => {
    rule.mockResolvedValueOnce({ ok: true });
    expect(await actions.rule(formEvent({ itemId: '5', level: '32' }))).toEqual({ success: true });
    expect(rule).toHaveBeenCalledWith(5, 32, 77);

    rule.mockResolvedValueOnce({ ok: false, error: 'decided' });
    expect(await actions.rule(formEvent({ itemId: '5', level: '4' }))).toMatchObject({
      status: 409,
      data: { error: 'decided' },
    });
  });

  it('fails the action, not the page, when the rating cannot be set', async () => {
    rule.mockRejectedValueOnce(new Error('Image not found'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await actions.rule(formEvent({ itemId: '5', level: '4' }))).toMatchObject({
      status: 500,
    });
  });
});
