import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `removeBlocklistItems` used to return void while its caller reported `count: items.length` — the
 * number SUBMITTED. So a removal that matched nothing still rendered "Removed 1 item." above a chip
 * that was still there. These pin the count against what the row actually lost.
 */

type Call = [string, unknown[]];

/** Rows keyed by id, so a query scoped to the wrong id resolves to nothing rather than passing. */
let rows: Record<number, string[]>;
const updateSpy = vi.fn();
const setSpy = vi.fn();

const wheres = (calls: Call[]) => calls.filter(([m]) => m === 'where').map(([, a]) => a);
const scopedId = (calls: Call[]) => {
  const match = wheres(calls).find(([column, op]) => column === 'id' && op === '=');
  return match?.[2] as number | undefined;
};

function chain(record: (calls: Call[]) => void, resolve: (calls: Call[]) => unknown) {
  const calls: Call[] = [];
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'set', 'where', 'orderBy', 'returning']) {
    builder[method] = (...args: unknown[]) => {
      calls.push([method, args]);
      return builder;
    };
  }
  const settle = async () => {
    record(calls);
    return resolve(calls);
  };
  builder.executeTakeFirst = settle;
  builder.executeTakeFirstOrThrow = settle;
  builder.execute = async () => {
    record(calls);
    const id = scopedId(calls);
    // `readBlocklistRow` selects by TYPE, not id, and expects an array.
    return id === undefined
      ? Object.entries(rows).map(([rowId, data]) => ({
          id: Number(rowId),
          type: 'EmailDomain',
          data,
        }))
      : [];
  };
  return builder;
}

vi.mock('../db', () => ({
  dbRead: {},
  dbWrite: {
    selectFrom: () =>
      chain(
        () => undefined,
        (calls) => {
          const id = scopedId(calls);
          return id !== undefined && rows[id] ? { data: rows[id] } : undefined;
        }
      ),
    updateTable: () =>
      chain(
        (calls) => updateSpy(calls),
        (calls) => {
          const id = scopedId(calls);
          expect(id, 'an UPDATE here must be scoped to a single row').toBeDefined();
          const set = calls.find(([m]) => m === 'set')?.[1][0] as { data: string[] };
          rows[id as number] = set.data;
          return { id, type: 'EmailDomain', data: set.data };
        }
      ),
  },
}));

vi.mock('../redis', () => ({ getRedis: () => ({ get: async () => null, set: setSpy }) }));
vi.mock('../axiom', () => ({ logToAxiom: vi.fn() }));

const { removeBlocklistItems } = await import('../blocklist.service');

beforeEach(() => {
  vi.clearAllMocks();
  rows = { 1: ['spam.example', 'junk.example', 'trash.example'] };
});

describe('removeBlocklistItems', () => {
  it('returns how many entries the row actually lost', async () => {
    const removed = await removeBlocklistItems({ id: 1, items: ['spam.example'] });

    expect(removed).toBe(1);
    expect(rows[1]).toEqual(['junk.example', 'trash.example']);
  });

  it('returns 0 for an entry that is not on the list, and writes nothing', async () => {
    const removed = await removeBlocklistItems({ id: 1, items: ['never-added.example'] });

    expect(removed).toBe(0);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(rows[1]).toHaveLength(3);
  });

  it('returns 0 for a stale row id rather than reporting the submitted count', async () => {
    const removed = await removeBlocklistItems({ id: 999, items: ['spam.example'] });

    expect(removed).toBe(0);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('counts only the entries that were present, not the whole submission', async () => {
    const removed = await removeBlocklistItems({
      id: 1,
      items: ['spam.example', 'never-added.example'],
    });

    expect(removed).toBe(1);
  });

  it('does not re-cache when nothing was removed', async () => {
    await removeBlocklistItems({ id: 1, items: ['never-added.example'] });

    expect(setSpy).not.toHaveBeenCalled();
  });
});
