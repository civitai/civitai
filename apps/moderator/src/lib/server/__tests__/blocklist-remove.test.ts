import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Two properties of the blocklist writers, neither visible from the page:
 *
 * 1. The count reported is what the row actually LOST, not what was submitted. It used to return
 *    void while the caller reported `items.length`, so a removal that matched nothing still
 *    rendered "Removed 1 item." above a chip that was still there.
 * 2. Every statement is scoped to (id, type), not to id alone. The posted id and the posted type
 *    are independent form fields; without the type predicate a hand-crafted post merges one type's
 *    entries into another type's row.
 */

type Call = [string, unknown[]];

let rows: Record<number, { type: string; data: string[] }>;
const updateSpy = vi.fn();
const setSpy = vi.fn();
/** Set by the SELECT chain, so a read that stops taking the row lock is visible here. */
let lockedReads = 0;

const wheres = (calls: Call[]) => calls.filter(([m]) => m === 'where').map(([, a]) => a);
const scope = (calls: Call[]) => ({
  id: wheres(calls).find(([column, op]) => column === 'id' && op === '=')?.[2] as
    | number
    | undefined,
  type: wheres(calls).find(([column, op]) => column === 'type' && op === '=')?.[2] as
    | string
    | undefined,
});

function chain(record: (calls: Call[]) => void, resolve: (calls: Call[]) => unknown) {
  const calls: Call[] = [];
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'set', 'where', 'orderBy', 'returning', 'forUpdate', 'values']) {
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
    const { id, type } = scope(calls);
    // `readBlocklistRow` selects by TYPE with no id, and expects an array.
    if (id !== undefined) return [];
    return Object.entries(rows)
      .filter(([, row]) => row.type === type)
      .map(([rowId, row]) => ({ id: Number(rowId), type: row.type, data: row.data }));
  };
  return builder;
}

/** Resolves a row the way the emitted SQL would: only the predicates actually present apply. */
const findRow = (calls: Call[]) => {
  const { id, type } = scope(calls);
  if (id === undefined) return undefined;
  const row = rows[id];
  if (!row) return undefined;
  if (type !== undefined && row.type !== type) return undefined;
  return row;
};

const selectFrom = () =>
  chain(
    (calls) => {
      if (calls.some(([m]) => m === 'forUpdate')) lockedReads += 1;
    },
    (calls) => {
      const row = findRow(calls);
      return row ? { data: row.data } : undefined;
    }
  );

const updateTable = () =>
  chain(
    (calls) => updateSpy(calls),
    (calls) => {
      const { id } = scope(calls);
      const row = findRow(calls);
      expect(row, 'an UPDATE here must resolve to exactly one row').toBeDefined();
      const set = calls.find(([m]) => m === 'set')?.[1][0] as { data: string[] };
      rows[id as number] = { type: (row as { type: string }).type, data: set.data };
      return { id, type: (row as { type: string }).type, data: set.data };
    }
  );

const insertInto = () =>
  chain(
    () => undefined,
    (calls) => {
      const values = calls.find(([m]) => m === 'values')?.[1][0] as {
        type: string;
        data: string[];
      };
      const id = Math.max(0, ...Object.keys(rows).map(Number)) + 1;
      rows[id] = { type: values.type, data: values.data };
      return { id, type: values.type, data: values.data };
    }
  );

const client = { selectFrom, updateTable, insertInto };

vi.mock('../db', () => ({
  dbRead: {},
  dbWrite: {
    ...client,
    transaction: () => ({
      execute: async (cb: (trx: typeof client) => unknown) => cb(client),
    }),
  },
}));

vi.mock('../redis', () => ({ getRedis: () => ({ get: async () => null, set: setSpy }) }));
vi.mock('../axiom', () => ({ logToAxiom: vi.fn() }));

const { removeBlocklistItems, upsertBlocklist, BlocklistRowMismatchError } = await import(
  '../blocklist.service'
);

beforeEach(() => {
  vi.clearAllMocks();
  lockedReads = 0;
  rows = {
    1: { type: 'EmailDomain', data: ['spam.example', 'junk.example', 'trash.example'] },
    4: { type: 'MessagePattern', data: ['unfreeze your funds'] },
  };
});

describe('removeBlocklistItems', () => {
  it('returns how many entries the row actually lost', async () => {
    const removed = await removeBlocklistItems({
      id: 1,
      type: 'EmailDomain',
      items: ['spam.example'],
    });

    expect(removed).toBe(1);
    expect(rows[1].data).toEqual(['junk.example', 'trash.example']);
  });

  it('returns 0 for an entry that is not on the list, and writes nothing', async () => {
    const removed = await removeBlocklistItems({
      id: 1,
      type: 'EmailDomain',
      items: ['never-added.example'],
    });

    expect(removed).toBe(0);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(rows[1].data).toHaveLength(3);
  });

  it('returns 0 for a stale row id rather than reporting the submitted count', async () => {
    const removed = await removeBlocklistItems({
      id: 999,
      type: 'EmailDomain',
      items: ['spam.example'],
    });

    expect(removed).toBe(0);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('counts only the entries that were present, not the whole submission', async () => {
    const removed = await removeBlocklistItems({
      id: 1,
      type: 'EmailDomain',
      items: ['spam.example', 'never-added.example'],
    });

    expect(removed).toBe(1);
  });

  it('does not re-cache when nothing was removed', async () => {
    await removeBlocklistItems({ id: 1, type: 'EmailDomain', items: ['never-added.example'] });

    expect(setSpy).not.toHaveBeenCalled();
  });

  it('refuses an id that belongs to a different type, leaving that row untouched', async () => {
    const removed = await removeBlocklistItems({
      id: 1,
      type: 'MessagePattern',
      items: ['spam.example'],
    });

    expect(removed).toBe(0);
    expect(rows[1].data).toEqual(['spam.example', 'junk.example', 'trash.example']);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('reads the row under a lock, so an overlapping removal cannot restore what it dropped', async () => {
    await removeBlocklistItems({ id: 1, type: 'EmailDomain', items: ['spam.example'] });

    expect(lockedReads, 'the read before the filtered write must be FOR UPDATE').toBe(1);
  });
});

describe('upsertBlocklist', () => {
  it('merges into the row when the id and type agree', async () => {
    await upsertBlocklist({ id: 1, type: 'EmailDomain', blocklist: ['New.Example'] });

    expect(rows[1].data).toEqual(['spam.example', 'junk.example', 'trash.example', 'new.example']);
  });

  it('refuses an id belonging to another type instead of merging across lists', async () => {
    await expect(
      upsertBlocklist({ id: 1, type: 'MessagePattern', blocklist: ['unfreeze your funds'] })
    ).rejects.toBeInstanceOf(BlocklistRowMismatchError);

    expect(rows[1].data, 'the EmailDomain row must not gain a message pattern').toEqual([
      'spam.example',
      'junk.example',
      'trash.example',
    ]);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('reads the row under a lock before merging', async () => {
    await upsertBlocklist({ id: 1, type: 'EmailDomain', blocklist: ['new.example'] });

    expect(lockedReads, 'the read before the merged write must be FOR UPDATE').toBe(1);
  });
});
