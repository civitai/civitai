import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getFlaggedModels, getFlaggedCount, getMinorFlagAppealsForReview } = vi.hoisted(() => ({
  getFlaggedModels: vi.fn(),
  getFlaggedCount: vi.fn(),
  getMinorFlagAppealsForReview: vi.fn(),
}));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/minor-hash.service', () => ({
  getAutoFlaggedMinorModels: vi.fn(),
  getMinorFlagAppealGroups: vi.fn(async () => []),
  getMinorFlagAppealsForReview,
  getMinorHashMatchesForReview: vi.fn(),
  getModelMinorState: vi.fn(),
  getFlaggedModels,
  getFlaggedCount,
}));
vi.mock('$lib/server/minor-flag.service', () => ({
  confirmMinorFlag: vi.fn(),
  dismissMinorHashMatch: vi.fn(),
  resolveMinorFlagAppeal: vi.fn(),
  resolveMinorFlagAppealPerLabel: vi.fn(),
  resolveRedetection: vi.fn(),
  revertMinorFlag: vi.fn(),
  setModelMinorFlag: vi.fn(),
}));

const { actions, load } = await import('../+page.server');

beforeEach(() => {
  vi.clearAllMocks();
  getMinorFlagAppealsForReview.mockResolvedValue({ items: [], hasMore: false });
});

describe('Model Flag Appeals', () => {
  it.each(['', '?view=redetected', '?view=bogus'])(
    'serves appeals and never queries held detections for %s',
    async (query) => {
      await (load as unknown as (e: { url: URL }) => Promise<unknown>)({
        url: new URL(`http://x/models/flags/appeals${query}`),
      });
      expect(getMinorFlagAppealsForReview).toHaveBeenCalledTimes(1);
      expect(getFlaggedModels).not.toHaveBeenCalled();
      expect(getFlaggedCount).not.toHaveBeenCalled();
    }
  );

  it('no longer carries the detection verdict actions', () => {
    expect(Object.keys(actions!).sort()).toEqual(['overturnAppeal', 'splitAppeal', 'upholdAppeal']);
  });
});
