import { beforeEach, describe, expect, it, vi } from 'vitest';

const svc = vi.hoisted(() => ({
  retire: vi.fn(),
  unretire: vi.fn(),
  reword: vi.fn(),
  items: vi.fn(),
  axes: vi.fn(),
}));

vi.mock('$lib/server/knights/yesno-question.service', () => ({
  retireYesNoQuestion: svc.retire,
  unretireYesNoQuestion: svc.unretire,
  rewordYesNoQuestion: svc.reword,
  getYesNoQuestionItems: svc.items,
  getYesNoAxes: svc.axes,
  YESNO_QUESTION_STATUSES: ['open', 'closed', 'all'],
}));
vi.mock('$lib/server/knights/yesno-reference.service', () => ({
  addYesNoReference: vi.fn(),
  setYesNoReferenceActive: vi.fn(),
  updateYesNoReference: vi.fn(),
  deleteYesNoReference: vi.fn(),
  getYesNoReferences: vi.fn(),
  getYesNoQuestions: vi.fn(),
  getYesNoReferenceCount: vi.fn().mockResolvedValue(0),
}));
vi.mock('$lib/server/knights/coreset.service', () => ({
  addCoreImage: vi.fn(),
  getCoreItems: vi.fn(),
  getCoreSetCounts: vi.fn().mockResolvedValue({ core: 0, fresh: 0, spotCheck: 0 }),
  getFreshItems: vi.fn(),
  getSpotCheckItems: vi.fn(),
  promoteToCore: vi.fn(),
  retireReference: vi.fn(),
  spotCheckItem: vi.fn(),
  updateCoreItem: vi.fn(),
}));
vi.mock('$lib/server/access', () => ({ requireAccess: vi.fn() }));
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

import { actions, load } from '../+page.server';

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

describe('Knights of New Order questions tab load', () => {
  const loadQuestions = (search: string) => {
    svc.items.mockResolvedValue({ items: [], total: 0, page: 1 });
    svc.axes.mockResolvedValue([{ key: 'knights.yesno.violence', prompt: 'Violence?' }]);
    return load({
      url: new URL(`http://localhost/knights-of-new-order/trials?tab=questions${search}`),
      locals: { user: { id: 77 } },
    } as never) as Promise<Record<string, any>>;
  };
  const queried = () => svc.items.mock.calls[0][0];

  beforeEach(() => vi.clearAllMocks());

  it('searches the image or the words for a bare number, only the image for a URL, only the words otherwise', async () => {
    await loadQuestions('&q=123');
    expect(queried()).toMatchObject({ search: { text: '123', imageId: 123 } });
    expect(queried().imageId).toBeUndefined();

    svc.items.mockClear();
    await loadQuestions(`&q=${encodeURIComponent('https://civitai.com/images/456')}`);
    expect(queried()).toMatchObject({ imageId: 456 });
    expect(queried().search).toBeUndefined();

    svc.items.mockClear();
    await loadQuestions('&q=knife');
    expect(queried()).toMatchObject({ search: { text: 'knife' } });
    expect(queried().search.imageId).toBeUndefined();
  });

  it('labels the axes once and passes an unknown axis from the URL through', async () => {
    const data = await loadQuestions('&axis=knights.yesno.gone&status=closed');
    expect(data.questionQueue.axes).toEqual([{ key: 'knights.yesno.violence', label: 'violence' }]);
    expect(data.questionQueue.filters).toEqual({ axis: 'knights.yesno.gone', status: 'closed' });
    expect(queried()).toMatchObject({ axis: 'knights.yesno.gone', status: 'closed' });
  });
});
