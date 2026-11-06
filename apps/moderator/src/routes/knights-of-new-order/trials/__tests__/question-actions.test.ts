import { beforeEach, describe, expect, it, vi } from 'vitest';

const svc = vi.hoisted(() => ({ retire: vi.fn(), unretire: vi.fn(), reword: vi.fn() }));

vi.mock('$lib/server/knights/yesno-question.service', () => ({
  retireYesNoQuestion: svc.retire,
  unretireYesNoQuestion: svc.unretire,
  rewordYesNoQuestion: svc.reword,
  getYesNoQuestionItems: vi.fn(),
  getYesNoAxes: vi.fn(),
  NOTE_MAX: 500,
  YESNO_QUESTION_STATUSES: ['open', 'closed', 'all'],
}));
vi.mock('$lib/server/knights/yesno-reference.service', () => ({
  addYesNoReference: vi.fn(),
  setYesNoReferenceActive: vi.fn(),
  updateYesNoReference: vi.fn(),
  deleteYesNoReference: vi.fn(),
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

describe('Knights of New Order question actions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('retires a question as the acting moderator with a trimmed note', async () => {
    svc.retire.mockResolvedValueOnce({ ok: true });
    const result = await actions.retireQuestion(formEvent({ id: '12', note: '  illegible  ' }));
    expect(result).toEqual({ success: true, agreed: undefined });
    expect(svc.retire).toHaveBeenCalledWith({ id: 12, note: 'illegible', by: 77 });
  });

  it('refuses a retirement without a note before touching the service', async () => {
    const result = await actions.retireQuestion(formEvent({ id: '12', note: '   ' }));
    expect(result).toMatchObject({ status: 400 });
    expect(svc.retire).not.toHaveBeenCalled();
  });

  it('rewords with the acting moderator and shows a refusal as a 409', async () => {
    svc.reword.mockResolvedValueOnce({
      ok: false,
      error: 'Only an open question can be reworded.',
    });
    const result = await actions.rewordQuestion(
      formEvent({ id: '12', prompt: ' Is a blade held? ', note: 'clearer' })
    );
    expect(svc.reword).toHaveBeenCalledWith({
      id: 12,
      prompt: 'Is a blade held?',
      note: 'clearer',
      by: 77,
    });
    expect(result).toMatchObject({
      status: 409,
      data: { error: 'Only an open question can be reworded.' },
    });
  });

  it('restores a question as the acting moderator', async () => {
    svc.unretire.mockResolvedValueOnce({ ok: true });
    await actions.unretireQuestion(formEvent({ id: '12' }));
    expect(svc.unretire).toHaveBeenCalledWith({ id: 12, by: 77 });
  });
});
