import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
const { getMinorHashMatchesForReview, getAutoFlaggedMinorModels } = vi.hoisted(() => ({
  getMinorHashMatchesForReview: vi.fn(async () => ({ items: [] })),
  getAutoFlaggedMinorModels: vi.fn(async () => ({ items: [] })),
}));
vi.mock('$lib/server/minor-hash.service', () => ({
  getAutoFlaggedMinorModels,
  getMinorFlagAppealsForReview: vi.fn(),
  getMinorHashMatchesForReview,
  getModelMinorState: vi.fn(),
}));
vi.mock('$lib/server/minor-flag.service', () => ({
  confirmMinorFlag: vi.fn(),
  dismissMinorHashMatch: vi.fn(),
  resolveMinorFlagAppeal: vi.fn(),
  resolveMinorFlagAppealPerLabel: vi.fn(),
  revertMinorFlag: vi.fn(),
  setModelMinorFlag: vi.fn(),
}));

const { actions, load } = await import('../+page.server');

describe('Model Flags / File matches', () => {
  it('keeps its actions', () => {
    expect(Object.keys(actions!).sort()).toEqual(['confirm', 'dismiss', 'revert', 'setMinor']);
  });

  it('always loads the pending queue, whatever ?tab= says', async () => {
    const data = await (load as (e: unknown) => Promise<Record<string, unknown>>)({
      url: new URL('http://x/models/flags/matches?tab=auto'),
    });
    expect(getMinorHashMatchesForReview).toHaveBeenCalledTimes(1);
    expect(getAutoFlaggedMinorModels).not.toHaveBeenCalled();
    expect(data).toMatchObject({ tab: 'pending', tabs: null });
  });
});
