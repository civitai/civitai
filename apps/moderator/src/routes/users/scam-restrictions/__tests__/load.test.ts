import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

const { getGenerationRestrictions } = vi.hoisted(() => ({
  getGenerationRestrictions: vi.fn(),
}));
vi.mock('$lib/server/user-restriction.service', () => ({
  getGenerationRestrictions,
  saveSuspiciousMatches: vi.fn(),
  unwiredRulingReason: vi.fn(),
}));
vi.mock('$lib/server/user-actions.service', () => ({
  banConfirmed: vi.fn(),
  resolveRestriction: vi.fn(),
  setBanned: vi.fn(),
}));

const { load, actions } = await import('../+page.server');

const run = (search = '') =>
  (load as unknown as (e: { url: URL }) => Promise<{ type: string }>)({
    url: new URL(`https://moderator.example/users/scam-restrictions${search}`),
  });

beforeEach(() => {
  vi.clearAllMocks();
  getGenerationRestrictions.mockResolvedValue({ items: [], totalCount: 0 });
});

describe('users/scam-restrictions load', () => {
  it.each(['', '?type=generation', '?type=bot-account', '?type=any'])(
    'only ever lists scam restrictions (%s)',
    async (search) => {
      const data = await run(search);
      expect(getGenerationRestrictions.mock.calls[0][0].type).toBe('scam');
      expect(data.type).toBe('scam');
    }
  );

  it('passes status, search and paging through', async () => {
    await run('?status=Upheld&q=bob&page=3');
    expect(getGenerationRestrictions).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'scam', status: 'Upheld', username: 'bob', page: 3 })
    );
  });

  it('offers the same actions as the generator queue', () => {
    expect(Object.keys(actions!).sort()).toEqual(['ban', 'flagSuspicious', 'resolve']);
  });
});
