import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const { tables, getGenerationRestrictions, setBanned, banConfirmed, resolveRestriction } =
  vi.hoisted(() => ({
    tables: {} as Record<string, Row[]>,
    getGenerationRestrictions: vi.fn(),
    setBanned: vi.fn(),
    banConfirmed: vi.fn(),
    resolveRestriction: vi.fn(),
  }));

// Each table answers with its fixture rows, filtered on the `in` list the code asks for.
vi.mock('$lib/server/db', () => {
  const chain = (table: string) => {
    let ids: unknown[] | null = null;
    let column = '';
    const q: Record<string, unknown> = {
      leftJoin: () => q,
      select: () => q,
      where: (col: string, _op: string, value: unknown[]) => {
        column = col.replace(/^r\./, '');
        ids = value;
        return q;
      },
      execute: async () => (tables[table] ?? []).filter((row) => !ids || ids.includes(row[column])),
    };
    return q;
  };
  return { dbRead: { selectFrom: (t: string) => chain(t.split(' ')[0]) }, dbWrite: {} };
});
vi.mock('$lib/server/user-restriction.service', () => ({ getGenerationRestrictions }));
vi.mock('$lib/server/user-actions.service', () => ({
  setBanned,
  banConfirmed,
  resolveRestriction,
}));

const { load, actions } = await import('../+page.server');

const restriction = (id: number, userId: number, entity = 'UserProfile') => ({
  id,
  userId,
  username: `user${userId}`,
  type: 'scam',
  status: 'Pending',
  createdAt: new Date(),
  userCreatedAt: new Date(),
  triggers: [{ key: `k${id}`, entityType: entity, entityId: userId, category: 'scam' }],
});

const run = (search = '') =>
  (load as unknown as (e: unknown) => Promise<Row & { rows: Row[] }>)({
    url: new URL(`https://moderator.example/users/scam-restrictions${search}`),
    locals: { grants: { 'audit.ban.execute': true } },
  });

const rule = (ban: number[], clear: number[], grants = { 'audit.ban.execute': true }) => {
  const body = new FormData();
  ban.forEach((id) => body.append('ban', String(id)));
  clear.forEach((id) => body.append('clear', String(id)));
  return (actions.rule as unknown as (e: unknown) => Promise<Row>)({
    request: new Request('https://moderator.example/users/scam-restrictions?/rule', {
      method: 'POST',
      body,
    }),
    locals: { user: { id: 99 }, grants },
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(tables)) delete tables[key];
  getGenerationRestrictions.mockResolvedValue({ items: [], totalCount: 0 });
  setBanned.mockResolvedValue({ ok: true });
  banConfirmed.mockResolvedValue(true);
  resolveRestriction.mockResolvedValue({ ok: true });
});

describe('scam restrictions load', () => {
  it('lists only pending scam restrictions, a bare number searched as a user id', async () => {
    await run('?q=12345&page=2');
    expect(getGenerationRestrictions).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'scam', status: 'Pending', userId: 12345, page: 2 })
    );
  });

  it('shows the text the scan read, as plain text with link targets kept', async () => {
    getGenerationRestrictions.mockResolvedValue({ items: [restriction(1, 10)], totalCount: 1 });
    tables.UserProfile = [
      {
        userId: 10,
        bio: '<p>Cheap buzz at <a href="https://scam.example">my shop</a></p>',
        message: null,
        sfwBio: null,
        sfwMessage: null,
      },
    ];
    const data = await run();
    expect(data.rows[0].scanned).toEqual([
      { heading: 'Bio', text: expect.stringContaining('[link: https://scam.example]') },
    ]);
    expect(String((data.rows[0].scanned as Row[])[0].text)).not.toContain('<');
  });
});

describe('scam restrictions bulk rule', () => {
  beforeEach(() => {
    tables.UserRestriction = [
      { id: 1, userId: 10, type: 'scam', status: 'Pending', username: 'a' },
      { id: 2, userId: 20, type: 'scam', status: 'Pending', username: 'b' },
      { id: 3, userId: 30, type: 'scam', status: 'Upheld', username: 'c' },
      { id: 4, userId: 40, type: 'generation', status: 'Pending', username: 'd' },
    ];
  });

  it('bans the ticked as spam with their content removed, and lifts the unticked', async () => {
    expect(await rule([1], [2])).toMatchObject({ banned: 1, cleared: 1, failed: [] });
    expect(setBanned).toHaveBeenCalledTimes(1);
    expect(setBanned).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 10,
        ban: true,
        reasonCode: 'SpamBot',
        removeMedia: true,
        removeModels: true,
        removeComments: true,
      })
    );
    expect(resolveRestriction).toHaveBeenCalledWith(
      expect.objectContaining({ userRestrictionId: 1, status: 'Upheld', userId: 10 })
    );
    expect(resolveRestriction).toHaveBeenCalledWith(
      expect.objectContaining({ userRestrictionId: 2, status: 'Overturned', userId: 20 })
    );
  });

  it('touches nothing that is not a pending scam restriction', async () => {
    const result = await rule([3, 4], [99]);
    expect(setBanned).not.toHaveBeenCalled();
    expect(resolveRestriction).not.toHaveBeenCalled();
    expect(result.failed).toHaveLength(3);
  });

  it('does not uphold a ban that has not taken effect', async () => {
    banConfirmed.mockResolvedValue(false);
    const result = await rule([1], []);
    expect(resolveRestriction).not.toHaveBeenCalled();
    expect(result).toMatchObject({ banned: 0, failed: [expect.objectContaining({ id: 1 })] });
  });

  it('refuses to ban without the audit ban grant, before anything is written', async () => {
    const result = await rule([1], [2], {} as { 'audit.ban.execute': boolean });
    expect(result).toMatchObject({ status: 403 });
    expect(setBanned).not.toHaveBeenCalled();
    expect(resolveRestriction).not.toHaveBeenCalled();
  });
});
