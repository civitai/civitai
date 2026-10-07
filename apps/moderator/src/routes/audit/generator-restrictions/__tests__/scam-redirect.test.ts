import { describe, expect, it, vi } from 'vitest';

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

const { load } = await import('../+page.server');

const run = (search: string) =>
  (load as unknown as (e: { url: URL }) => Promise<{ type: string }>)({
    url: new URL(`https://moderator.example/audit/generator-restrictions${search}`),
  });

const redirectOf = async (search: string) => {
  try {
    await run(search);
  } catch (e) {
    return e as { status: number; location: string };
  }
  return null;
};

describe('generator-restrictions — the scam queue moved to Users', () => {
  it('redirects ?type=scam to /users/scam-restrictions, keeping the other params', async () => {
    const r = await redirectOf('?type=scam&status=any&q=bob&selected=12&page=2');
    expect(r?.status).toBe(307);
    const target = new URL(r!.location, 'https://moderator.example');
    expect(target.pathname).toBe('/users/scam-restrictions');
    expect(Object.fromEntries(target.searchParams)).toEqual({
      status: 'any',
      q: 'bob',
      selected: '12',
      page: '2',
    });
    expect(getGenerationRestrictions).not.toHaveBeenCalled();
  });

  it('redirects a bare ?type=scam without a query string', async () => {
    const r = await redirectOf('?type=scam');
    expect(r?.location).toBe('/users/scam-restrictions');
  });

  it('does not redirect the remaining types', async () => {
    getGenerationRestrictions.mockResolvedValue({ items: [], totalCount: 0 });
    expect(await redirectOf('?type=bot-account')).toBeNull();
    expect(getGenerationRestrictions.mock.calls[0][0].type).toBe('bot-account');
  });
});
