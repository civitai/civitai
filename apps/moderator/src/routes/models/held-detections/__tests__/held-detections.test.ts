import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveRedetection, getRedetectedModels, getRedetectedCount } = vi.hoisted(() => ({
  resolveRedetection: vi.fn(),
  getRedetectedModels: vi.fn(),
  getRedetectedCount: vi.fn(),
}));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/minor-hash.service', () => ({
  getAutoFlaggedMinorModels: vi.fn(),
  getMinorFlagAppealGroups: vi.fn(async () => []),
  getMinorHashMatchesForReview: vi.fn(),
  getModelMinorState: vi.fn(),
  getRedetectedModels,
  getRedetectedCount,
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
  return { request: new Request('http://x/models/held-detections', { method: 'POST', body }) };
};
type ActionEvent = Parameters<NonNullable<typeof actions>[string]>[0];
const run = (name: string, fields: Record<string, string>) =>
  actions![name](post(fields) as unknown as ActionEvent) as Promise<Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  resolveRedetection.mockResolvedValue({ ok: true, resolved: 'kept' });
  getRedetectedModels.mockResolvedValue({ items: [], hasMore: false });
  getRedetectedCount.mockResolvedValue(3);
});

const kept = { resolvedReason: 'detection-correct' };
const dismissed = { resolvedReason: 'not-a-minor' };

describe('re-detection actions', () => {
  it('keep forwards the label, the reason and keeps', async () => {
    expect(
      await run('keepRedetected', { modelId: '42', label: 'poi', textHash: 'h-1', ...kept })
    ).toMatchObject({ success: true, modelId: 42, resolved: 'kept' });
    expect(resolveRedetection).toHaveBeenCalledWith(42, 'poi', true, 'h-1', {
      resolvedReason: 'detection-correct',
      internalNotes: undefined,
    });
  });

  it('hands the main app\'s "already flagged" answer to the page', async () => {
    resolveRedetection.mockResolvedValue({ ok: true, resolved: 'closed' });
    expect(
      await run('keepRedetected', { modelId: '42', label: 'minor', textHash: 'h-1', ...kept })
    ).toMatchObject({ success: true, resolved: 'closed' });
  });

  it('dismiss forwards the label, the reason and note, and dismisses', async () => {
    await run('dismissRedetected', {
      modelId: '42',
      label: 'minor',
      textHash: 'h-1',
      resolvedReason: 'other',
      internalNotes: 'a cartoon',
    });
    expect(resolveRedetection).toHaveBeenCalledWith(42, 'minor', false, 'h-1', {
      resolvedReason: 'other',
      internalNotes: 'a cartoon',
    });
  });

  it.each([
    ['an unknown label', { modelId: '42', label: 'nsfw', textHash: 'h-1', ...kept }],
    ['no model', { label: 'minor', textHash: 'h-1', ...kept }],
    ['no text hash', { modelId: '42', label: 'minor', ...kept }],
    ['no reason', { modelId: '42', label: 'minor', textHash: 'h-1' }],
    ['a dismissal reason', { modelId: '42', label: 'minor', textHash: 'h-1', ...dismissed }],
    [
      'Other without a note',
      { modelId: '42', label: 'minor', textHash: 'h-1', resolvedReason: 'other' },
    ],
  ])('refuses %s on a keep before calling the main app', async (_name, fields) => {
    const result = await run('keepRedetected', fields);
    expect(result).toMatchObject({ status: 400 });
    expect(resolveRedetection).not.toHaveBeenCalled();
  });

  it('refuses a keep reason on a dismissal', async () => {
    const result = await run('dismissRedetected', {
      modelId: '42',
      label: 'minor',
      textHash: 'h-1',
      ...kept,
    });
    expect(result).toMatchObject({ status: 400, data: { modelId: 42 } });
    expect(resolveRedetection).not.toHaveBeenCalled();
  });

  it('shows a refusal instead of reporting success', async () => {
    resolveRedetection.mockResolvedValue({ ok: false, error: 'Reload the queue.' });
    const result = (await run('dismissRedetected', {
      modelId: '42',
      label: 'minor',
      textHash: 'h-1',
      ...dismissed,
    })) as {
      status: number;
      data: { error: string; modelId: number };
    };
    expect(result.status).toBe(400);
    expect(result.data).toMatchObject({ error: 'Reload the queue.', modelId: 42 });
  });
});

describe('queue load', () => {
  type Loaded = { redetectedFilters: unknown; items: unknown[] };
  const loadQueue = async (query = '') =>
    (await (load as unknown as (e: { url: URL }) => Promise<Loaded>)({
      url: new URL(`http://x/models/held-detections${query}`),
    })) as Loaded;

  it('lists the held detections and never queries appeals', async () => {
    await loadQueue();
    expect(getRedetectedModels).toHaveBeenCalledTimes(1);
  });

  it('ignores a leftover ?view param', async () => {
    await loadQueue('?view=appeals');
    expect(getRedetectedModels).toHaveBeenCalledTimes(1);
  });

  it('still serves the list when the total fails', async () => {
    getRedetectedCount.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const loaded = await loadQueue();
    expect(loaded.items).toEqual([]);
  });

  it('passes the flag and sort filters through, ignoring unknown values', async () => {
    await loadQueue('?flag=poi&sort=newest');
    expect(getRedetectedModels).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters: { flag: 'poi', sort: 'newest' } })
    );
    await loadQueue('?flag=unflagged&sort=flagged');
    expect(getRedetectedModels).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters: { flag: 'all', sort: 'oldest' } })
    );
  });
});
