import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The inbox `load` — where an unreadable ruling store must become "state unknown", never "unruled",
 * and where a ClickHouse failure must not be mistaken for an empty source.
 */

const { listSupportGroups, currentResolutions, getSupportHeader } = vi.hoisted(() => ({
  listSupportGroups: vi.fn(),
  currentResolutions: vi.fn(),
  getSupportHeader: vi.fn(),
}));

vi.mock('$lib/server/decision-sources/support', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/decision-sources/support')>()),
  supportVersion: vi.fn(async () => ({ version: 'v', overridden: false })),
  getSupportHeader,
  listSupportTopics: vi.fn(async () => []),
  listSupportGroups,
}));
vi.mock('$lib/server/decision-resolution.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/decision-resolution.service')>()),
  currentResolutions,
}));
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

const { load } = await import('../+page.server');

type Out = {
  sourceStatus: string;
  storeStatus: string;
  stateApplied: boolean;
  total: number;
  rows: { groupKey: string; state: string | null }[];
};
const MOD = { id: 7, roles: ['moderator:cm-high'] };
const run = (qs = '', user: { id: number; roles: string[] } = MOD) =>
  (load as unknown as (e: unknown) => Promise<Out>)({
    url: new URL(`https://moderator.example/decisions${qs}`),
    locals: { user },
  });

const row = (groupKey: string) => ({ groupKey });

beforeEach(() => {
  for (const m of [listSupportGroups, currentResolutions, getSupportHeader]) m.mockReset();
  getSupportHeader.mockResolvedValue({ warnings: [] });
  listSupportGroups.mockResolvedValue({ rows: [row('g0'), row('g1')], truncated: false });
  currentResolutions.mockResolvedValue([]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('inbox load', () => {
  it('asks for the admin-only header notes for an admin, and only for an admin', async () => {
    await run('', { id: 1, roles: ['moderator:admin'] });
    expect(getSupportHeader).toHaveBeenLastCalledWith('v', { pinned: false, admin: true });
    await run('');
    expect(getSupportHeader).toHaveBeenLastCalledWith('v', { pinned: false, admin: false });
  });

  it('a missing ruling table is unknown state, not a backlog of "unruled"', async () => {
    currentResolutions.mockRejectedValue(Object.assign(new Error('no table'), { code: '42P01' }));
    const out = await run('?state=unruled');
    expect(out.storeStatus).toBe('no-schema');
    expect(out.stateApplied).toBe(false);
    expect(out.total).toBe(2);
    expect(out.rows.map((r) => r.state)).toEqual([null, null]);
  });

  it('applies the state filter when the store reads', async () => {
    currentResolutions.mockResolvedValue([
      {
        id: '1',
        itemKey: 'g0',
        subKey: '',
        ruling: 'correct',
        targetKey: null,
        escalateTo: null,
        note: null,
        ruledBy: 1,
        ruledAt: new Date(0),
        applyState: 'n/a',
      },
    ]);
    const out = await run('?state=unruled');
    expect(out.storeStatus).toBe('ok');
    expect(out.stateApplied).toBe(true);
    expect(out.rows.map((r) => [r.groupKey, r.state])).toEqual([['g1', 'unruled']]);
  });

  it('a ClickHouse failure is "unreachable", not an empty source', async () => {
    listSupportGroups.mockRejectedValue(new Error('timeout'));
    const out = await run();
    expect(out.sourceStatus).toBe('unreachable');
  });

  it('passes the area filter through to the source', async () => {
    await run('?topic=billing-buzz');
    expect(listSupportGroups).toHaveBeenCalledWith({ version: 'v', topic: 'billing-buzz' });
  });
});
