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

const { load, actions } = await import('../+page.server');
const { TABS } = await import('../tabs');

const redirectOf = async (search: string) => {
  try {
    await (load as unknown as (e: { url: URL }) => Promise<unknown>)({
      url: new URL(`https://moderator.example/models/minor-hash-matches${search}`),
    });
  } catch (e) {
    return e as { status: number; location: string };
  }
  return null;
};

describe('minor-hash-matches — appeals moved to /models/flag-appeals', () => {
  it('redirects ?tab=appeals, keeping search and paging', async () => {
    const r = await redirectOf('?tab=appeals&q=bob&page=2');
    expect(r?.status).toBe(307);
    const target = new URL(r!.location, 'https://moderator.example');
    expect(target.pathname).toBe('/models/flag-appeals');
    expect(Object.fromEntries(target.searchParams)).toEqual({ q: 'bob', page: '2' });
  });

  it('does not redirect its own tabs', async () => {
    expect(await redirectOf('?tab=auto')).toBeNull();
    expect(await redirectOf('')).toBeNull();
  });

  it('has only its own tabs and actions', () => {
    expect(TABS.map((t) => t.value)).toEqual(['pending', 'auto']);
    expect(Object.keys(actions!).sort()).toEqual(['confirm', 'dismiss', 'revert', 'setMinor']);
  });
});
