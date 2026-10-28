import { beforeEach, describe, expect, it, vi } from 'vitest';

// This app mints its own orchestrator key, so it refuses a banned account the same way the main
// app's mint does: before the insert, and again after it.

type Call = { op: string; table: string; values?: unknown; where: unknown[][] };
const state = vi.hoisted(() => ({ calls: [] as Call[], banned: [] as boolean[] }));

function chain(op: string, table: string) {
  const call: Call = { op, table, where: [] };
  state.calls.push(call);
  const builder = {
    select: () => builder,
    values: (values: unknown) => ((call.values = values), builder),
    set: (values: unknown) => ((call.values = values), builder),
    where: (...args: unknown[]) => (call.where.push(args), builder),
    execute: async () => [],
    executeTakeFirst: async () => ({ bannedAt: state.banned.shift() ? new Date() : null }),
  };
  return builder;
}
vi.mock('../db', () => ({
  db: {
    selectFrom: (table: string) => chain('select', table),
    insertInto: (table: string) => chain('insert', table),
    updateTable: (table: string) => chain('update', table),
    deleteFrom: (table: string) => chain('delete', table),
  },
}));
vi.mock('../redis', () => ({
  getSysRedis: () => ({ hGet: async () => null, packed: { hGet: async () => null } }),
}));
vi.mock('../redis-atomic', () => ({ hSetWithTTL: vi.fn(async () => undefined) }));

const { orchestratorToken, BannedAccountError } = await import('../orchestrator-token');

const USER = 4242;
const ops = () => state.calls.filter((c) => c.table === 'ApiKey').map((c) => c.op);

beforeEach(() => {
  state.calls = [];
  state.banned = [];
  delete process.env.ORCHESTRATOR_MODE;
  process.env.NEXTAUTH_SECRET ??= 'test-secret';
});

describe('orchestratorToken', () => {
  it('mints a key for an account in good standing', async () => {
    state.banned = [false, false];
    await expect(orchestratorToken(USER)).resolves.toEqual(expect.any(String));
    expect(ops()).toEqual(['insert', 'delete']);
  });

  it('refuses a banned account before writing a key', async () => {
    state.banned = [true];
    await expect(orchestratorToken(USER)).rejects.toBeInstanceOf(BannedAccountError);
    expect(ops()).toEqual([]);
  });

  it('expires the key it just wrote when a ban lands while it mints', async () => {
    state.banned = [false, true];
    await expect(orchestratorToken(USER)).rejects.toBeInstanceOf(BannedAccountError);
    const [insert, expire] = state.calls.filter((c) => c.table === 'ApiKey');
    expect(ops()).toEqual(['insert', 'update']);
    expect(expire.where).toEqual([['key', '=', (insert.values as { key: string }).key]]);
  });
});
