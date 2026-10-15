import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveRedetection, getRedetectedModels, getMinorFlagAppealsForReview } = vi.hoisted(
  () => ({
    resolveRedetection: vi.fn(),
    getRedetectedModels: vi.fn(),
    getMinorFlagAppealsForReview: vi.fn(),
  })
);

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/minor-hash.service', () => ({
  getAutoFlaggedMinorModels: vi.fn(),
  getMinorFlagAppealGroups: vi.fn(async () => []),
  getMinorFlagAppealsForReview,
  getMinorHashMatchesForReview: vi.fn(),
  getModelMinorState: vi.fn(),
  getRedetectedModels,
}));
vi.mock('$lib/server/minor-flag.service', () => ({
  confirmMinorFlag: vi.fn(),
  dismissMinorHashMatch: vi.fn(),
  resolveMinorFlagAppeal: vi.fn(),
  resolveMinorFlagAppealPerLabel: vi.fn(),
  resolveRedetection,
  revertMinorFlag: vi.fn(),
  setModelMinorFlag: vi.fn(),
}));

const { actions, load } = await import('../+page.server');

const post = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return { request: new Request('http://x/models/flag-appeals', { method: 'POST', body }) };
};
type ActionEvent = Parameters<NonNullable<typeof actions>[string]>[0];
const run = (name: string, fields: Record<string, string>) =>
  actions![name](post(fields) as unknown as ActionEvent) as Promise<Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  resolveRedetection.mockResolvedValue({ ok: true, resolved: 'kept' });
  getRedetectedModels.mockResolvedValue({ items: [], hasMore: false });
  getMinorFlagAppealsForReview.mockResolvedValue({ items: [], hasMore: false });
});

describe('re-detection actions', () => {
  it('keep forwards the label and keeps', async () => {
    expect(
      await run('keepRedetected', { modelId: '42', label: 'poi', textHash: 'h-1' })
    ).toMatchObject({ success: true, modelId: 42, resolved: 'kept' });
    expect(resolveRedetection).toHaveBeenCalledWith(42, 'poi', true, 'h-1');
  });

  it('hands the main app\'s "already flagged" answer to the page', async () => {
    resolveRedetection.mockResolvedValue({ ok: true, resolved: 'closed' });
    expect(
      await run('keepRedetected', { modelId: '42', label: 'minor', textHash: 'h-1' })
    ).toMatchObject({ success: true, resolved: 'closed' });
  });

  it('dismiss forwards the label and dismisses', async () => {
    await run('dismissRedetected', { modelId: '42', label: 'minor', textHash: 'h-1' });
    expect(resolveRedetection).toHaveBeenCalledWith(42, 'minor', false, 'h-1');
  });

  it.each([
    ['an unknown label', { modelId: '42', label: 'nsfw', textHash: 'h-1' }],
    ['no model', { label: 'minor', textHash: 'h-1' }],
    ['no text hash', { modelId: '42', label: 'minor' }],
  ])('refuses %s before calling the main app', async (_name, fields) => {
    const result = await run('keepRedetected', fields);
    expect(result).toMatchObject({ status: 400 });
    expect(resolveRedetection).not.toHaveBeenCalled();
  });

  it('shows a refusal instead of reporting success', async () => {
    resolveRedetection.mockResolvedValue({ ok: false, error: 'Reload the queue.' });
    const result = (await run('dismissRedetected', {
      modelId: '42',
      label: 'minor',
      textHash: 'h-1',
    })) as {
      status: number;
      data: { error: string; modelId: number };
    };
    expect(result.status).toBe(400);
    expect(result.data).toMatchObject({ error: 'Reload the queue.', modelId: 42 });
  });
});

describe('queue view', () => {
  const view = async (query: string) =>
    (
      await (load as unknown as (e: { url: URL }) => Promise<{ view: string }>)({
        url: new URL(`http://x/models/flag-appeals${query}`),
      })
    ).view;

  it('loads the re-detected list only for ?view=redetected', async () => {
    expect(await view('?view=redetected')).toBe('redetected');
    expect(getRedetectedModels).toHaveBeenCalledTimes(1);
    expect(getMinorFlagAppealsForReview).not.toHaveBeenCalled();
  });

  it.each([
    ['', 'no view'],
    ['?view=appeals', 'the appeals view'],
    ['?view=bogus', 'an unknown view'],
  ])('serves appeals and never queries re-detections for %s', async (query) => {
    expect(await view(query)).toBe('appeals');
    expect(getRedetectedModels).not.toHaveBeenCalled();
    expect(getMinorFlagAppealsForReview).toHaveBeenCalledTimes(1);
  });
});
