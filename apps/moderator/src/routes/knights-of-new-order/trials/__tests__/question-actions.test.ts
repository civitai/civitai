import { beforeEach, describe, expect, it, vi } from 'vitest';

const svc = vi.hoisted(() => ({
  retire: vi.fn(),
  unretire: vi.fn(),
  reword: vi.fn(),
  keep: vi.fn(),
  remove: vi.fn(),
  returnPull: vi.fn(),
  orphans: vi.fn(),
  items: vi.fn(),
  axes: vi.fn(),
}));

vi.mock('$lib/server/knights/yesno-question.service', () => ({
  retireYesNoQuestion: svc.retire,
  unretireYesNoQuestion: svc.unretire,
  rewordYesNoQuestion: svc.reword,
  keepReportedQuestion: svc.keep,
  removeReportedQuestion: svc.remove,
  returnImagePull: svc.returnPull,
  getOrphanImagePulls: svc.orphans,
  imagePullImageIds: vi.fn(async () => []),
  getYesNoQuestionItems: svc.items,
  getYesNoAxes: svc.axes,
  yesNoQuestionImageIds: vi.fn(async () => []),
  YESNO_QUESTION_STATUSES: ['open', 'reported', 'closed', 'all'],
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
// Acting as a moderator with the media grant: withheld.pglite.test.ts covers the refusal itself.
vi.mock('$lib/server/access', () => ({ requireAccess: vi.fn(), canAccess: () => true }));
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

  it('keeps and removes a reported question as the acting moderator', async () => {
    svc.keep.mockResolvedValueOnce({ ok: true });
    expect(await actions.keepReported(formEvent({ id: '12' }))).toEqual({
      success: true,
      agreed: undefined,
    });
    expect(svc.keep).toHaveBeenCalledWith({ id: 12, by: 77 });

    svc.remove.mockResolvedValueOnce({ ok: false, error: 'Only a reported question can be kept or removed.' });
    expect(await actions.removeReported(formEvent({ id: '12' }))).toMatchObject({ status: 409 });
    expect(svc.remove).toHaveBeenCalledWith({ id: 12, by: 77 });
  });

  it('returns a pulled image as the acting moderator', async () => {
    svc.returnPull.mockResolvedValueOnce({ ok: true });
    expect(await actions.returnImage(formEvent({ id: '9' }))).toEqual({
      success: true,
      agreed: undefined,
    });
    expect(svc.returnPull).toHaveBeenCalledWith({ id: 9, by: 77 });
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
    svc.orphans.mockResolvedValueOnce([{ id: 9, imageId: 5, imageKey: 'k5', imageName: null }]);
    const reported = await loadQuestions('&status=reported');
    expect(reported.questionQueue.filters.status).toBe('reported');
    expect(reported.questionQueue.pulledImages).toEqual([
      { id: 9, imageId: 5, imageKey: 'k5', imageName: null, restricted: false },
    ]);
    expect((await loadQuestions('&status=open')).questionQueue.pulledImages).toEqual([]);
    expect(svc.orphans).toHaveBeenCalledTimes(1);
    svc.items.mockClear();
    const data = await loadQuestions('&axis=knights.yesno.gone&status=closed');
    expect(data.questionQueue.axes).toEqual([{ key: 'knights.yesno.violence', label: 'violence' }]);
    expect(data.questionQueue.filters).toEqual({ axis: 'knights.yesno.gone', status: 'closed' });
    expect(queried()).toMatchObject({ axis: 'knights.yesno.gone', status: 'closed' });
  });
});
