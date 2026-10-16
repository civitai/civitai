import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getMinorHashMatchesForReview,
  getMinorQueueCounts,
  setModelMinorFlag,
  dismissMinorHashMatch,
} = vi.hoisted(() => ({
  getMinorHashMatchesForReview: vi.fn(),
  getMinorQueueCounts: vi.fn(),
  setModelMinorFlag: vi.fn(),
  dismissMinorHashMatch: vi.fn(),
}));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/minor-hash.service', () => ({
  getMinorFlagAppealGroups: vi.fn(),
  getMinorFlagAppealsForReview: vi.fn(),
  getMinorHashMatchesForReview,
  getMinorQueueCounts,
  getFlaggedModels: vi.fn(),
  getFlaggedCount: vi.fn(),
}));
vi.mock('$lib/server/minor-flag.service', () => ({
  confirmMinorFlag: vi.fn(),
  dismissMinorHashMatch,
  resolveMinorFlagAppeal: vi.fn(),
  resolveMinorFlagAppealPerLabel: vi.fn(),
  resolveRedetection: vi.fn(),
  revertMinorFlag: vi.fn(),
  setModelMinorFlag,
}));

const { actions, load } = await import('../+page.server');

type LoadEvent = Parameters<NonNullable<typeof load>>[0];
const loadAt = (query = '') =>
  (load as (e: unknown) => Promise<Record<string, unknown>>)({
    url: new URL(`http://x/models/flags/matches${query}`),
  } as LoadEvent);

const post = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return { request: new Request('http://x/models/flags/matches', { method: 'POST', body }) };
};
type ActionEvent = Parameters<NonNullable<typeof actions>[string]>[0];
const run = (name: string, fields: Record<string, string>) =>
  actions![name](post(fields) as unknown as ActionEvent) as Promise<Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  getMinorHashMatchesForReview.mockResolvedValue({ items: [], hasMore: false });
  getMinorQueueCounts.mockResolvedValue({ pending: 8 });
  setModelMinorFlag.mockResolvedValue({ ok: true });
  dismissMinorHashMatch.mockResolvedValue({ ok: true });
});

describe('Model Flags / File matches', () => {
  it('has the two decisions and nothing else', () => {
    expect(Object.keys(actions!).sort()).toEqual(['dismiss', 'setMinor']);
  });

  it('loads the pending queue with the whole queue as its total', async () => {
    expect(await loadAt()).toMatchObject({ page: 1, offset: 0, hasMore: false, total: 8 });
    expect(getMinorHashMatchesForReview).toHaveBeenCalledWith({
      limit: 50,
      offset: 0,
      search: undefined,
    });
  });

  it('offers no total for a search, which narrows the list but not the count', async () => {
    const data = await loadAt('?q=42&page=2&limit=10');
    expect(data).toMatchObject({ total: undefined, page: 2, offset: 10, q: '42' });
    expect(getMinorHashMatchesForReview).toHaveBeenCalledWith({
      limit: 10,
      offset: 10,
      search: { modelOrUserId: 42 },
    });
    expect(getMinorQueueCounts).not.toHaveBeenCalled();
  });

  it('still lists the page when the total fails', async () => {
    getMinorQueueCounts.mockRejectedValue(new Error('slow'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await loadAt()).toMatchObject({ items: [], total: undefined });
  });

  it('drops the total when the count never resolves, and releases the timer when it does', async () => {
    vi.useFakeTimers();
    try {
      getMinorQueueCounts.mockReturnValue(new Promise(() => {}));
      const pending = loadAt();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await pending).toMatchObject({ items: [], total: undefined });
      expect(vi.getTimerCount()).toBe(0);

      getMinorQueueCounts.mockResolvedValue({ pending: 8 });
      expect(await loadAt()).toMatchObject({ total: 8 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flags as minor by model id', async () => {
    expect(await run('setMinor', { modelId: '7' })).toMatchObject({ success: true, modelId: 7 });
    expect(setModelMinorFlag).toHaveBeenCalledWith(7);
    expect(dismissMinorHashMatch).not.toHaveBeenCalled();
  });

  it('dismisses by model id', async () => {
    expect(await run('dismiss', { modelId: '7' })).toMatchObject({ success: true, modelId: 7 });
    expect(dismissMinorHashMatch).toHaveBeenCalledWith(7);
    expect(setModelMinorFlag).not.toHaveBeenCalled();
  });

  it("shows the main app's refusal against the model instead of reporting success", async () => {
    setModelMinorFlag.mockResolvedValue({ ok: false, error: 'Model not found.' });
    expect(await run('setMinor', { modelId: '7' })).toMatchObject({
      status: 400,
      data: { error: 'Model not found.', modelId: 7, subject: 'Model #7' },
    });
  });

  it('refuses a missing model id before calling the main app', async () => {
    expect(await run('dismiss', {})).toMatchObject({ status: 400 });
    expect(dismissMinorHashMatch).not.toHaveBeenCalled();
  });
});
