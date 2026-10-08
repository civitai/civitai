import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

const { getGenerationRestrictions } = vi.hoisted(() => ({
  getGenerationRestrictions: vi.fn(),
}));
vi.mock('$lib/server/user-restriction.service', () => ({
  getGenerationRestrictions,
  saveSuspiciousMatches: vi.fn(),
  unwiredRulingReason: vi.fn(() => null),
}));
const { resolveRestriction, setBanned } = vi.hoisted(() => ({
  resolveRestriction: vi.fn(),
  setBanned: vi.fn(),
}));
vi.mock('$lib/server/user-actions.service', () => ({
  banConfirmed: vi.fn(),
  resolveRestriction,
  setBanned,
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

describe('users/scam-restrictions actions — queue scope', () => {
  const event = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [k, v] of Object.entries(fields)) data.append(k, v);
    return {
      request: { formData: async () => data },
      locals: { user: { id: 7 }, grants: { 'audit.ban.execute': true } },
    } as never;
  };
  const row = (type: string) => ({ id: 5, userId: 42, type, triggers: [] });

  it('refuses a generation restriction id on every action', async () => {
    getGenerationRestrictions.mockResolvedValue({ items: [row('generation')], totalCount: 1 });

    const results = (await Promise.all([
      actions!.resolve!(event({ userRestrictionId: '5', status: 'Upheld' })),
      actions!.ban!(event({ userRestrictionId: '5' })),
      actions!.flagSuspicious!(event({ userRestrictionId: '5', key: '5-0' })),
    ])) as { status: number }[];

    expect(results.map((r) => r.status)).toEqual([404, 404, 404]);
    expect(resolveRestriction).not.toHaveBeenCalled();
    expect(setBanned).not.toHaveBeenCalled();
  });

  it('resolves a scam restriction', async () => {
    getGenerationRestrictions.mockResolvedValue({ items: [row('scam')], totalCount: 1 });
    resolveRestriction.mockResolvedValue({ ok: true });

    const result = await actions!.resolve!(
      event({
        userRestrictionId: '5',
        status: 'Overturned',
        resolvedReason: 'other',
        internalNotes: 'not a scam account',
      })
    );

    expect(result).toEqual({ success: true });
    expect(resolveRestriction).toHaveBeenCalledWith(
      expect.objectContaining({
        userRestrictionId: 5,
        status: 'Overturned',
        userId: 42,
        resolvedReason: 'other',
        internalNotes: 'not a scam account',
      })
    );
  });

  it('refuses a scam ruling with no reason, without ruling', async () => {
    getGenerationRestrictions.mockResolvedValue({ items: [row('scam')], totalCount: 1 });

    const result = (await actions!.resolve!(
      event({ userRestrictionId: '5', status: 'Upheld' })
    )) as { status: number; data: { error: string } };

    expect(result.status).toBe(400);
    expect(result.data.error).toMatch(/Pick a reason/);
    expect(resolveRestriction).not.toHaveBeenCalled();
  });
});
