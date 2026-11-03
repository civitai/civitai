import { beforeEach, describe, expect, it, vi } from 'vitest';

const svc = vi.hoisted(() => ({
  add: vi.fn(),
  setActive: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('$lib/server/knights/yesno-reference.service', () => ({
  addYesNoReference: svc.add,
  setYesNoReferenceActive: svc.setActive,
  deleteYesNoReference: svc.remove,
  getYesNoReferences: vi.fn(),
  getYesNoQuestions: vi.fn(),
  getYesNoReferenceCount: vi.fn(),
}));
vi.mock('$lib/server/knights/coreset.service', () => ({
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

describe('Knights of New Order yes/no reference actions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('adds a pair with the acting moderator and an image id taken from a pasted URL', async () => {
    svc.add.mockResolvedValueOnce({ ok: true });
    const result = await actions.addYesNo(
      formEvent({
        image: 'https://civitai.com/images/123?postId=5',
        questionKey: 'q.safe',
        answer: 'yes',
        explanation: 'Why',
      })
    );
    expect(result).toEqual({ success: true, agreed: undefined });
    expect(svc.add).toHaveBeenCalledWith({
      imageId: 123,
      questionKey: 'q.safe',
      answer: true,
      explanation: 'Why',
      createdBy: 77,
    });
  });

  it('accepts a plain image id and the no answer, with an empty explanation', async () => {
    svc.add.mockResolvedValueOnce({ ok: true });
    await actions.addYesNo(formEvent({ image: '45', questionKey: 'q.safe', answer: 'no' }));
    expect(svc.add).toHaveBeenCalledWith(
      expect.objectContaining({ imageId: 45, answer: false, explanation: '' })
    );
  });

  it.each([
    ['an unreadable image', { image: 'not an image', questionKey: 'q', answer: 'yes' }],
    ['an unknown answer', { image: '1', questionKey: 'q', answer: 'maybe' }],
    ['a missing question', { image: '1', answer: 'yes' }],
  ])('rejects %s without calling the service', async (_, fields) => {
    const result = await actions.addYesNo(formEvent(fields));
    expect(result).toMatchObject({ status: 400 });
    expect(svc.add).not.toHaveBeenCalled();
  });

  it('surfaces a duplicate or invalid question as a conflict with the service message', async () => {
    svc.add.mockResolvedValueOnce({ ok: false, error: 'Image 1 already has a reference.' });
    const result = await actions.addYesNo(
      formEvent({ image: '1', questionKey: 'q.safe', answer: 'yes' })
    );
    expect(result).toMatchObject({
      status: 409,
      data: { error: 'Image 1 already has a reference.' },
    });
  });

  it('toggles active and deletes by id', async () => {
    svc.setActive.mockResolvedValueOnce({ ok: true });
    svc.remove.mockResolvedValueOnce({ ok: true });
    expect(await actions.toggleYesNo(formEvent({ id: '5', active: 'false' }))).toMatchObject({
      success: true,
    });
    expect(svc.setActive).toHaveBeenCalledWith(5, false);
    expect(await actions.deleteYesNo(formEvent({ id: '5' }))).toMatchObject({ success: true });
    expect(svc.remove).toHaveBeenCalledWith(5);
    expect(await actions.deleteYesNo(formEvent({ id: 'abc' }))).toMatchObject({ status: 400 });
  });

  it('turns a thrown service error into a 500 that changed nothing', async () => {
    svc.remove.mockRejectedValueOnce(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await actions.deleteYesNo(formEvent({ id: '5' }))).toMatchObject({ status: 500 });
  });
});
