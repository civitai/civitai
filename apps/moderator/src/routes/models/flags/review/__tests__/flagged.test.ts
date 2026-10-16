import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveRedetection, confirmMinorFlag, revertMinorFlag, getFlaggedModels, getFlaggedCount } =
  vi.hoisted(() => ({
    resolveRedetection: vi.fn(),
    confirmMinorFlag: vi.fn(),
    revertMinorFlag: vi.fn(),
    getFlaggedModels: vi.fn(),
    getFlaggedCount: vi.fn(),
  }));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/minor-hash.service', () => ({
  getAutoFlaggedMinorModels: vi.fn(),
  getMinorFlagAppealGroups: vi.fn(async () => []),
  getMinorHashMatchesForReview: vi.fn(),
  getModelMinorState: vi.fn(),
  getFlaggedModels,
  getFlaggedCount,
}));
vi.mock('$lib/server/minor-flag.service', () => ({
  confirmMinorFlag,
  dismissMinorHashMatch: vi.fn(),
  resolveMinorFlagAppeal: vi.fn(),
  resolveMinorFlagAppealPerLabel: vi.fn(),
  resolveRedetection,
  revertMinorFlag,
  setModelMinorFlag: vi.fn(),
}));

const { actions, load } = await import('../+page.server');

const post = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return { request: new Request('http://x/models/flags/review', { method: 'POST', body }) };
};
type ActionEvent = Parameters<NonNullable<typeof actions>[string]>[0];
const run = (name: string, fields: Record<string, string>) =>
  actions![name](post(fields) as unknown as ActionEvent) as Promise<Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  resolveRedetection.mockResolvedValue({ ok: true, resolved: 'kept' });
  confirmMinorFlag.mockResolvedValue({ ok: true });
  revertMinorFlag.mockResolvedValue({ ok: true });
  getFlaggedModels.mockResolvedValue({ items: [], hasMore: false });
  getFlaggedCount.mockResolvedValue(3);
});

const redetected = { modelId: '42', label: 'minor', source: 'redetected', textHash: 'h-1' };
const kept = { resolvedReason: 'detection-correct' };
const dismissed = { resolvedReason: 'not-a-minor' };

describe('hash flag actions', () => {
  const hash = { modelId: '42', label: 'minor', source: 'hash' };

  it('keep confirms the flag by model id and records no reason', async () => {
    expect(await run('keepFlag', { ...hash, ...kept })).toMatchObject({
      success: true,
      modelId: 42,
      resolved: 'kept',
    });
    expect(confirmMinorFlag).toHaveBeenCalledWith(42);
    expect(revertMinorFlag).not.toHaveBeenCalled();
    expect(resolveRedetection).not.toHaveBeenCalled();
  });

  it.each(['keepFlag', 'liftFlag'])('%s refuses a poi label on a hash flag', async (action) => {
    const result = await run(action, { ...hash, label: 'poi', ...kept });
    expect(result).toMatchObject({
      status: 400,
      data: { error: 'A hash flag can only be ruled as minor.', modelId: 42 },
    });
    expect(confirmMinorFlag).not.toHaveBeenCalled();
    expect(revertMinorFlag).not.toHaveBeenCalled();
  });

  it('lift reverts the flag by model id', async () => {
    expect(await run('liftFlag', hash)).toMatchObject({ success: true, resolved: 'dismissed' });
    expect(revertMinorFlag).toHaveBeenCalledWith(42);
    expect(confirmMinorFlag).not.toHaveBeenCalled();
  });

  it("shows the main app's refusal against the model instead of reporting success", async () => {
    confirmMinorFlag.mockResolvedValue({ ok: false, error: 'Appeal open.' });
    expect(await run('keepFlag', hash)).toMatchObject({
      status: 400,
      data: { error: 'Appeal open.', modelId: 42, subject: 'Model #42' },
    });
  });
});

describe('re-detection actions', () => {
  it('keep forwards the label, the reason and keeps', async () => {
    expect(await run('keepFlag', { ...redetected, label: 'poi', ...kept })).toMatchObject({
      success: true,
      modelId: 42,
      resolved: 'kept',
    });
    expect(resolveRedetection).toHaveBeenCalledWith(42, 'poi', true, 'h-1', {
      resolvedReason: 'detection-correct',
      internalNotes: undefined,
    });
    expect(confirmMinorFlag).not.toHaveBeenCalled();
  });

  it('hands the main app\'s "already flagged" answer to the page', async () => {
    resolveRedetection.mockResolvedValue({ ok: true, resolved: 'closed' });
    expect(await run('keepFlag', { ...redetected, ...kept })).toMatchObject({
      success: true,
      resolved: 'closed',
    });
  });

  it('lift forwards the label, the reason and note, and dismisses', async () => {
    await run('liftFlag', {
      ...redetected,
      resolvedReason: 'other',
      internalNotes: 'a cartoon',
    });
    expect(resolveRedetection).toHaveBeenCalledWith(42, 'minor', false, 'h-1', {
      resolvedReason: 'other',
      internalNotes: 'a cartoon',
    });
  });

  it.each([
    ['an unknown label', { ...redetected, label: 'nsfw', ...kept }],
    ['an unknown source', { ...redetected, source: 'other', ...kept }],
    ['no model', { label: 'minor', source: 'redetected', textHash: 'h-1', ...kept }],
    ['no text hash', { modelId: '42', label: 'minor', source: 'redetected', ...kept }],
    ['no reason', redetected],
    ['a dismissal reason', { ...redetected, ...dismissed }],
    ['Other without a note', { ...redetected, resolvedReason: 'other' }],
  ])('refuses %s on a keep before calling the main app', async (_name, fields) => {
    const result = await run('keepFlag', fields);
    expect(result).toMatchObject({ status: 400 });
    expect(resolveRedetection).not.toHaveBeenCalled();
    expect(confirmMinorFlag).not.toHaveBeenCalled();
  });

  it('refuses a reason bound to the other label', async () => {
    const result = await run('liftFlag', { ...redetected, label: 'poi', ...dismissed });
    expect(result).toMatchObject({
      status: 400,
      data: { error: expect.stringMatching(/does not apply/) },
    });
    expect(resolveRedetection).not.toHaveBeenCalled();
  });

  it('refuses a keep reason on a dismissal', async () => {
    const result = await run('liftFlag', { ...redetected, ...kept });
    expect(result).toMatchObject({ status: 400, data: { modelId: 42 } });
    expect(resolveRedetection).not.toHaveBeenCalled();
  });

  it('shows a refusal instead of reporting success', async () => {
    resolveRedetection.mockResolvedValue({ ok: false, error: 'Reload the queue.' });
    const result = (await run('liftFlag', { ...redetected, ...dismissed })) as {
      status: number;
      data: { error: string; modelId: number };
    };
    expect(result.status).toBe(400);
    expect(result.data).toMatchObject({ error: 'Reload the queue.', modelId: 42 });
  });
});

describe('queue load', () => {
  type Loaded = { flaggedFilters: unknown; items: unknown[] };
  const loadQueue = async (query = '') =>
    (await (load as unknown as (e: { url: URL }) => Promise<Loaded>)({
      url: new URL(`http://x/models/flags/review${query}`),
    })) as Loaded;

  it('ignores a leftover ?view or ?tab param', async () => {
    await loadQueue('?view=appeals&tab=auto');
    expect(getFlaggedModels).toHaveBeenCalledTimes(1);
  });

  it('still serves the list when the total fails', async () => {
    getFlaggedCount.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const loaded = await loadQueue();
    expect(loaded.items).toEqual([]);
  });

  it('honours the source the held-detections redirect sends', async () => {
    await loadQueue('?source=redetected');
    expect(getFlaggedModels).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters: { source: 'redetected', flag: 'all', sort: 'oldest' } })
    );
    expect(getFlaggedCount).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: 'redetected', flag: 'all' })
    );
  });

  it('passes the filters through, ignoring unknown values', async () => {
    await loadQueue('?source=hash&flag=poi&sort=newest');
    expect(getFlaggedModels).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters: { source: 'hash', flag: 'poi', sort: 'newest' } })
    );
    await loadQueue('?source=text&flag=unflagged&sort=flagged');
    expect(getFlaggedModels).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters: { source: 'all', flag: 'all', sort: 'oldest' } })
    );
  });
});
