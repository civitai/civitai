import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/minor-hash.service', () => ({
  getAutoFlaggedMinorModels: vi.fn(async () => ({ items: [] })),
  getMinorFlagAppealsForReview: vi.fn(),
  getMinorHashMatchesForReview: vi.fn(async () => ({ items: [] })),
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

const { actions } = await import('../+page.server');
const { TABS } = await import('../tabs');

describe('minor-hash-matches — appeals moved to /models/flag-appeals', () => {
  it('has only its own tabs and actions', () => {
    expect(TABS.map((t) => t.value)).toEqual(['pending', 'auto']);
    expect(Object.keys(actions!).sort()).toEqual(['confirm', 'dismiss', 'revert', 'setMinor']);
  });
});
