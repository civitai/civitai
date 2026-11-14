import { beforeEach, describe, expect, it, vi } from 'vitest';

const svc = vi.hoisted(() => ({
  add: vi.fn(),
  setActive: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('$lib/server/knights/yesno-reference.service', () => ({
  addYesNoReference: svc.add,
  setYesNoReferenceActive: svc.setActive,
  updateYesNoReference: svc.update,
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
        prompt: '  Is a knife held?  ',
        answer: 'yes',
        explanation: 'Why',
      })
    );
    expect(result).toEqual({ success: true, agreed: undefined });
    expect(svc.add).toHaveBeenCalledWith({
      imageId: 123,
      questionKey: 'q.safe',
      prompt: 'Is a knife held?',
      answer: true,
      explanation: 'Why',
      createdBy: 77,
    });
  });

  it('accepts a plain image id and the no answer, with an empty explanation', async () => {
    svc.add.mockResolvedValueOnce({ ok: true });
    await actions.addYesNo(
      formEvent({ image: '45', questionKey: 'q.safe', prompt: 'Asked?', answer: 'no' })
    );
    expect(svc.add).toHaveBeenCalledWith(
      expect.objectContaining({ imageId: 45, answer: false, explanation: '' })
    );
  });

  it.each([
    ['an unreadable image', { image: 'not an image', questionKey: 'q', answer: 'yes' }],
    ['an unknown answer', { image: '1', questionKey: 'q', prompt: 'Asked?', answer: 'maybe' }],
    ['a missing question', { image: '1', prompt: 'Asked?', answer: 'yes' }],
    ['a missing prompt', { image: '1', questionKey: 'q', answer: 'yes' }],
    ['a blank prompt', { image: '1', questionKey: 'q', prompt: '   ', answer: 'yes' }],
    [
      'a prompt over the limit',
      { image: '1', questionKey: 'q', prompt: 'x'.repeat(601), answer: 'yes' },
    ],
  ])('rejects %s without calling the service', async (_, fields) => {
    const result = await actions.addYesNo(formEvent(fields));
    expect(result).toMatchObject({ status: 400 });
    expect(svc.add).not.toHaveBeenCalled();
  });

  it('tells the moderator what to enter when the image field is unreadable', async () => {
    const result = await actions.addYesNo(
      formEvent({ image: 'abc', questionKey: 'q', prompt: 'Asked?', answer: 'yes' })
    );
    expect(JSON.stringify(result)).toContain('Enter an image id or an image page URL.');
  });

  it.each([
    ['zero', '0'],
    ['past int4', '2147483648'],
    ['a zero page URL', 'https://civitai.com/images/0'],
  ])('gives the same message for an out-of-range image id (%s)', async (_, image) => {
    const result = await actions.addYesNo(
      formEvent({ image, questionKey: 'q', prompt: 'Asked?', answer: 'yes' })
    );
    expect(JSON.stringify(result)).toContain('Enter an image id or an image page URL.');
    expect(svc.add).not.toHaveBeenCalled();
  });

  it('surfaces a duplicate or invalid question as a conflict with the service message', async () => {
    svc.add.mockResolvedValueOnce({ ok: false, error: 'Image 1 already has a reference.' });
    const result = await actions.addYesNo(
      formEvent({ image: '1', questionKey: 'q.safe', prompt: 'Asked?', answer: 'yes' })
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

  it('saves an edited prompt, answer and explanation by id, and rejects an unknown answer or a blank prompt', async () => {
    svc.update.mockResolvedValueOnce({ ok: true });
    expect(
      await actions.updateYesNo(
        formEvent({ id: '5', prompt: ' Asked? ', answer: 'no', explanation: 'Why' })
      )
    ).toMatchObject({ success: true });
    expect(svc.update).toHaveBeenCalledWith(5, {
      prompt: 'Asked?',
      answer: false,
      explanation: 'Why',
    });
    expect(
      await actions.updateYesNo(formEvent({ id: '5', prompt: 'Asked?', answer: 'maybe' }))
    ).toMatchObject({ status: 400 });
    expect(
      await actions.updateYesNo(formEvent({ id: '5', prompt: '  ', answer: 'yes' }))
    ).toMatchObject({ status: 400 });
    expect(svc.update).toHaveBeenCalledTimes(1);
  });

  it('saves an edit with no explanation field as an empty explanation', async () => {
    svc.update.mockResolvedValueOnce({ ok: true });
    await actions.updateYesNo(formEvent({ id: '5', prompt: 'Asked?', answer: 'yes' }));
    expect(svc.update).toHaveBeenCalledWith(5, {
      prompt: 'Asked?',
      answer: true,
      explanation: '',
    });
  });

  it('shows the service refusal when a pair with answers is edited', async () => {
    svc.update.mockResolvedValueOnce({ ok: false, error: 'Deactivate it instead.' });
    expect(
      await actions.updateYesNo(formEvent({ id: '5', prompt: 'Asked?', answer: 'no' }))
    ).toMatchObject({
      status: 409,
      data: { error: 'Deactivate it instead.' },
    });
  });

  it('shows the service refusal when a pair with answers is deleted', async () => {
    svc.remove.mockResolvedValueOnce({ ok: false, error: 'Deactivate it instead.' });
    expect(await actions.deleteYesNo(formEvent({ id: '5' }))).toMatchObject({
      status: 409,
      data: { error: 'Deactivate it instead.' },
    });
  });

  it('turns a thrown service error into a 500 that changed nothing', async () => {
    svc.remove.mockRejectedValueOnce(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await actions.deleteYesNo(formEvent({ id: '5' }))).toMatchObject({ status: 500 });
  });
});
