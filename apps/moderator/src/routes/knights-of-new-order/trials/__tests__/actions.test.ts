import { beforeEach, describe, expect, it, vi } from 'vitest';

const svc = vi.hoisted(() => ({
  addCoreImage: vi.fn(),
  getCoreItems: vi.fn(),
  getCoreSetCounts: vi.fn(),
  getFreshItems: vi.fn(),
  getSpotCheckItems: vi.fn(),
  promoteToCore: vi.fn(),
  retireReference: vi.fn(),
  spotCheckItem: vi.fn(),
  updateCoreItem: vi.fn(),
}));

vi.mock('$lib/server/knights/coreset.service', () => svc);
vi.mock('$lib/server/access', () => ({ requireAccess: vi.fn() }));
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

import { actions } from '../+page.server';

const formEvent = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return {
    request: { formData: async () => data },
    locals: { user: { id: 77 } },
    url: new URL('http://localhost/knights-of-new-order/trials'),
  } as never;
};

describe('Knights of New Order Trials actions', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['add without an image id', 'add', { level: '4', explanation: 'why' }],
    ['add with a malformed image id', 'add', { imageId: 'abc', level: '4', explanation: 'why' }],
    ['update without a level', 'update', { id: '3', explanation: 'why' }],
    ['retire with a malformed id', 'retire', { id: '-1' }],
    ['spot-check without a level', 'spotCheck', { id: '3' }],
  ] as const)('rejects %s without writing', async (_label, action, fields) => {
    expect(await actions[action](formEvent(fields))).toMatchObject({ status: 400 });
    for (const fn of Object.values(svc)) expect(fn).not.toHaveBeenCalled();
  });

  it('adds a core image with the typed level and why', async () => {
    svc.addCoreImage.mockResolvedValueOnce({ ok: true });
    expect(
      await actions.add(formEvent({ imageId: '12', level: '8', explanation: 'because' }))
    ).toMatchObject({ success: true });
    expect(svc.addCoreImage).toHaveBeenCalledWith({
      imageId: 12,
      level: 8,
      explanation: 'because',
    });
  });

  it('promotes without a why', async () => {
    svc.promoteToCore.mockResolvedValueOnce({ ok: true });
    await actions.promote(formEvent({ id: '4' }));
    expect(svc.promoteToCore).toHaveBeenCalledWith({ id: 4, explanation: '' });
  });

  it('shows a refusal as a conflict and tells the spot-check outcome', async () => {
    svc.retireReference.mockResolvedValueOnce({ ok: false, error: 'gone' });
    expect(await actions.retire(formEvent({ id: '4' }))).toMatchObject({
      status: 409,
      data: { error: 'gone' },
    });

    svc.spotCheckItem.mockResolvedValueOnce({ ok: true, agreed: false });
    expect(await actions.spotCheck(formEvent({ id: '4', level: '2' }))).toEqual({
      success: true,
      agreed: false,
    });
  });

  it('fails the action, not the page, when a write throws', async () => {
    svc.updateCoreItem.mockRejectedValueOnce(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(
      await actions.update(formEvent({ id: '4', level: '4', explanation: 'x' }))
    ).toMatchObject({ status: 500 });
  });
});
