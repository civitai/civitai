import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Four properties of the blocklist writers, none of them visible from the page:
 *
 * 1. The count reported is what the row actually GAINED or LOST, not what was submitted.
 * 2. Every statement is scoped to (id, type), not to id alone. The posted id and the posted type
 *    are independent form fields; without the type predicate a hand-crafted post merges one type's
 *    entries into another type's row.
 * 3. The locked read and the write run inside ONE transaction. A lock taken by a transaction that
 *    has already committed is inert.
 * 4. The write BUSTS the shared Redis key rather than rewriting it, because writing a snapshot is
 *    itself an unserialised read-modify-write over the artifact every reader enforces from.
 */

type Call = [string, unknown[]];
type On = 'dbWrite' | 'trx';

let rows: Record<number, { type: string; data: string[] }>;
const updateSpy = vi.fn<(arg: { on: On; wheres: unknown[][] }) => void>();
const insertSpy = vi.fn<(arg: { on: On; type: string; data: string[] }) => void>();
const setSpy = vi.fn();
const delSpy = vi.fn();
/** Which client each locked read ran on. Empty means a read stopped taking the row lock at all. */
let lockedReads: On[] = [];
/** How many transactions were opened. Zero means the statements ran outside one. */
let transactions = 0;
/** An UPDATE whose predicates resolved no row — recorded, never asserted inside the resolver. */
let unscopedUpdates = 0;
/** Every `orderBy` the code emitted, so the ordering is pinned rather than supplied by the fake. */
let orderBys: unknown[][] = [];

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
    return matching(calls).map(([id, row]) => ({ id, type: row.type, data: row.data }));
  };
  return builder;
}

/**
 * Rows the emitted SQL would match: ONLY the predicates actually present apply. A fake that refused
 * a row for some other reason would let a dropped predicate pass for the wrong cause.
 *
 * 🔴 Ordering is applied ONLY when `orderBy('id','asc')` was actually recorded. Sorting
 * unconditionally hands the code a guarantee it may not have emitted — deleting the `orderBy` then
 * passes every test while Postgres is free to return any row of the type, which on a duplicate is
 * the "the edit went to the row nobody reads" bug this file exists to prevent. Unordered, the fake
 * returns rows HIGHEST id first, so the wrong element surfaces as a wrong value.
 */
function matching(calls: Call[]): [number, { type: string; data: string[] }][] {
  const { id, type } = scope(calls);
  const ordersById = calls.some(
    ([m, args]) => m === 'orderBy' && args[0] === 'id' && args[1] === 'asc'
  );
  const matched = Object.entries(rows)
    .map(([rowId, row]) => [Number(rowId), row] as [number, { type: string; data: string[] }])
    .filter(
      ([rowId, row]) =>
        (id === undefined || rowId === id) && (type === undefined || row.type === type)
    );
  return matched.sort((a, b) => (ordersById ? a[0] - b[0] : b[0] - a[0]));
}

const selectFrom = (on: On) =>
  chain(
    (calls) => {
      if (calls.some(([m]) => m === 'forUpdate')) lockedReads.push(on);
      for (const [method, args] of calls) if (method === 'orderBy') orderBys.push(args);
    },
    (calls) => {
      const [first] = matching(calls);
      return first ? { id: first[0], data: first[1].data } : undefined;
    }
  );

const updateTable = (on: On) =>
  chain(
    (calls) => updateSpy({ on, wheres: wheres(calls) }),
    (calls) => {
      const [first] = matching(calls);
      // Counted, not asserted: an `expect` inside a resolver throws THROUGH the service, so the
      // failure surfaces as a service error at an unrelated call site instead of as an assertion.
      if (!first) {
        unscopedUpdates += 1;
        return undefined;
      }
      const [id, row] = first;
      const set = calls.find(([m]) => m === 'set')?.[1][0] as { data: string[] };
      rows[id] = { type: row.type, data: set.data };
      return { id, type: row.type, data: set.data };
    }
  );

const insertInto = (on: On) =>
  chain(
    () => undefined,
    (calls) => {
      const values = calls.find(([m]) => m === 'values')?.[1][0] as {
        type: string;
        data: string[];
      };
      insertSpy({ on, type: values.type, data: values.data });
      const id = Math.max(0, ...Object.keys(rows).map(Number)) + 1;
      rows[id] = { type: values.type, data: values.data };
      return { id, type: values.type, data: values.data };
    }
  );

/**
 * 🔴 The transaction client is a DISTINCT object from `dbWrite`, and every statement records which
 * one it ran on. With ONE shared object the fake cannot tell `trx.selectFrom` from
 * `dbWrite.selectFrom` — so deleting the `dbWrite.transaction().execute(...)` wrapper and running
 * the same statements on the bare client left every test green with the atomicity fix fully
 * reverted. A lock held by a transaction that has already committed is inert, and that is exactly
 * the shape that reads as fixed and is not.
 */
const clientFor = (on: On) => ({
  selectFrom: () => selectFrom(on),
  updateTable: () => updateTable(on),
  insertInto: () => insertInto(on),
});

const trxClient = clientFor('trx');

vi.mock('../db', () => ({
  dbRead: {},
  dbWrite: {
    ...clientFor('dbWrite'),
    transaction: () => ({
      execute: async (cb: (trx: unknown) => unknown) => {
        transactions += 1;
        return cb(trxClient);
      },
    }),
  },
}));

vi.mock('../redis', () => ({
  getRedis: () => ({ get: async () => null, set: setSpy, del: delSpy }),
}));
vi.mock('../axiom', () => ({ logToAxiom: vi.fn() }));

const recordModActivitySpy = vi.fn();
vi.mock('../mod-activity', () => ({
  recordModActivity: (...args: unknown[]) => recordModActivitySpy(...args),
}));

/** The moderator making the edit. Attribution is the whole point, so it is never a default. */
const MOD_ID = 77;

const { removeBlocklistItems, upsertBlocklist, getBlocklistDTO, BlocklistRowMismatchError } =
  await import('../blocklist.service');

beforeEach(() => {
  vi.clearAllMocks();
  lockedReads = [];
  orderBys = [];
  transactions = 0;
  unscopedUpdates = 0;
  rows = {
    1: { type: 'EmailDomain', data: ['spam.example', 'junk.example', 'trash.example'] },
    4: { type: 'MessagePattern', data: ['unfreeze your funds'] },
  };
});

/** A second row for a type. Nothing prevents one, and which row wins is the whole question. */
const addDuplicateEmailDomainRow = () => {
  rows[9] = { type: 'EmailDomain', data: ['duplicate-row-nobody-reads.example'] };
};

/** Both writers must satisfy these, so they are asserted for each rather than for one. */
const expectLockedInsideOneTransaction = () => {
  expect(transactions, 'the statements must run inside a transaction').toBe(1);
  expect(lockedReads, 'the read must be FOR UPDATE, on the transaction client').toEqual(['trx']);
  expect(unscopedUpdates, 'no UPDATE may resolve a row its predicates should exclude').toBe(0);
  expect(updateSpy.mock.calls.map(([arg]) => arg.on)).not.toContain('dbWrite');
};

describe('removeBlocklistItems', () => {
  it('returns how many entries the row actually lost', async () => {
    const { count } = await removeBlocklistItems({
      userId: MOD_ID,
      id: 1,
      type: 'EmailDomain',
      items: ['spam.example'],
    });

    expect(count).toBe(1);
    expect(rows[1].data).toEqual(['junk.example', 'trash.example']);
    expectLockedInsideOneTransaction();
  });

  it('scopes the UPDATE to the type as well as the id', async () => {
    await removeBlocklistItems({
      userId: MOD_ID,
      id: 1,
      type: 'EmailDomain',
      items: ['spam.example'],
    });

    // The UPDATE runs only after the scoped SELECT already matched, so the fake resolves the same
    // row with or without this predicate. Nothing but reading the statement can see it.
    expect(updateSpy.mock.calls[0][0].wheres).toEqual([
      ['id', '=', 1],
      ['type', '=', 'EmailDomain'],
    ]);
  });

  it('returns 0 for an entry that is not on the list, and writes nothing', async () => {
    const { count } = await removeBlocklistItems({
      userId: MOD_ID,
      id: 1,
      type: 'EmailDomain',
      items: ['never-added.example'],
    });

    expect(count).toBe(0);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(rows[1].data).toHaveLength(3);
  });

  it('returns 0 for a stale row id rather than reporting the submitted count', async () => {
    const { count } = await removeBlocklistItems({
      userId: MOD_ID,
      id: 999,
      type: 'EmailDomain',
      items: ['spam.example'],
    });

    expect(count).toBe(0);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('counts only the entries that were present, not the whole submission', async () => {
    const { count } = await removeBlocklistItems({
      userId: MOD_ID,
      id: 1,
      type: 'EmailDomain',
      items: ['spam.example', 'never-added.example'],
    });

    expect(count).toBe(1);
  });

  it('refuses an id that belongs to a different type, leaving that row untouched', async () => {
    const { count } = await removeBlocklistItems({
      userId: MOD_ID,
      id: 1,
      type: 'MessagePattern',
      items: ['spam.example'],
    });

    expect(count).toBe(0);
    expect(rows[1].data).toEqual(['spam.example', 'junk.example', 'trash.example']);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

describe('upsertBlocklist', () => {
  it('merges into the row when the id and type agree, and counts what it gained', async () => {
    const { count } = await upsertBlocklist({
      userId: MOD_ID,
      id: 1,
      type: 'EmailDomain',
      blocklist: ['New.Example'],
    });

    expect(count).toBe(1);
    expect(rows[1].data).toEqual(['spam.example', 'junk.example', 'trash.example', 'new.example']);
    expectLockedInsideOneTransaction();
  });

  it('reports what the row GAINED, not what was submitted', async () => {
    // Two of the three are already on the list. Reporting 3 is the "the screen says it happened"
    // defect the removal count was fixed for, on the other half of the same page.
    const { count } = await upsertBlocklist({
      userId: MOD_ID,
      id: 1,
      type: 'EmailDomain',
      blocklist: ['spam.example', 'junk.example', 'new.example'],
    });

    expect(count).toBe(1);
  });

  it('reports 0 and writes nothing when every entry is already on the list', async () => {
    const { count } = await upsertBlocklist({
      userId: MOD_ID,
      id: 1,
      type: 'EmailDomain',
      blocklist: ['spam.example'],
    });

    expect(count).toBe(0);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(delSpy).not.toHaveBeenCalled();
  });

  it('scopes the UPDATE to the type as well as the id', async () => {
    await upsertBlocklist({
      userId: MOD_ID,
      id: 1,
      type: 'EmailDomain',
      blocklist: ['new.example'],
    });

    expect(updateSpy.mock.calls[0][0].wheres).toEqual([
      ['id', '=', 1],
      ['type', '=', 'EmailDomain'],
    ]);
  });

  it('refuses an id belonging to another type instead of merging across lists', async () => {
    await expect(
      upsertBlocklist({
        userId: MOD_ID,
        id: 1,
        type: 'MessagePattern',
        blocklist: ['unfreeze your funds'],
      })
    ).rejects.toBeInstanceOf(BlocklistRowMismatchError);

    expect(rows[1].data, 'the EmailDomain row must not gain a message pattern').toEqual([
      'spam.example',
      'junk.example',
      'trash.example',
    ]);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(delSpy).not.toHaveBeenCalled();
  });

  it('merges into the existing row of the type when no id was posted', async () => {
    // `UsernameExact` is a tab with no row in production, so its adds arrive with no `id` — and an
    // unconditional insert there gives the type a second row whose entries are never enforced.
    // The same shape reaches every other tab from a stale form.
    const { count } = await upsertBlocklist({
      userId: MOD_ID,
      type: 'EmailDomain',
      blocklist: ['new.example'],
    });

    expect(count).toBe(1);
    expect(
      insertSpy,
      'a type that already has a row must not gain a second'
    ).not.toHaveBeenCalled();
    expect(rows[1].data).toContain('new.example');
    expect(Object.keys(rows)).toHaveLength(2);
  });

  it('merges into the LOWEST row of the type, the one readBlocklistRow enforces', async () => {
    // 🔴 Needs a type with TWO rows. With one, every ordering picks the same row, so dropping the
    // `orderBy` — or reading the wrong end of the result — passes while an add lands on a row
    // nobody reads: banner says "Added 1 item", cache busted, page reloads unchanged.
    addDuplicateEmailDomainRow();

    await upsertBlocklist({
      userId: MOD_ID,
      type: 'EmailDomain',
      blocklist: ['new.example'],
    });

    expect(rows[1].data, 'the lowest row is the one that must gain the entry').toContain(
      'new.example'
    );
    expect(rows[9].data).toEqual(['duplicate-row-nobody-reads.example']);
  });

  it('asks for id order rather than relying on the row it happens to get back', async () => {
    addDuplicateEmailDomainRow();

    await upsertBlocklist({
      userId: MOD_ID,
      type: 'EmailDomain',
      blocklist: ['new.example'],
    });

    expect(orderBys, 'the locking read must order by id ASC').toContainEqual(['id', 'asc']);
  });

  it('inserts only when the type genuinely has no row, and counts every entry inserted', async () => {
    // More than one item, because `return items.length` and `return 1` are indistinguishable on a
    // single-entry insert — and seeding a brand-new tab from a pasted list is exactly that case.
    const { count } = await upsertBlocklist({
      userId: MOD_ID,
      type: 'UsernameExact',
      blocklist: ['Scammer', 'Phisher', 'Spammer'],
    });

    expect(count).toBe(3);
    expect(insertSpy).toHaveBeenCalledWith({
      on: 'trx',
      type: 'UsernameExact',
      data: ['scammer', 'phisher', 'spammer'],
    });
  });
});

describe('moderator attribution', () => {
  // An edit to a moderation control with no ModActivity row is unattributable after the fact: the
  // Blocklist row carries only `updatedAt`, so who added or removed an entry is recoverable from
  // nothing else. Deleting these calls loses that with no other symptom.
  it('records who added entries, against the row that changed', async () => {
    await upsertBlocklist({
      userId: MOD_ID,
      id: 1,
      type: 'EmailDomain',
      blocklist: ['new.example'],
    });

    expect(recordModActivitySpy).toHaveBeenCalledWith({
      userId: MOD_ID,
      entityType: 'blocklist',
      entityId: 1,
      activity: 'add',
    });
  });

  it('records the INSERTED row id when the type had no row yet', async () => {
    // The id is only knowable from the insert's own RETURNING. Passing the submitted (absent) id
    // here would record `undefined` against a row that does exist.
    await upsertBlocklist({
      userId: MOD_ID,
      type: 'UsernameExact',
      blocklist: ['scammer'],
    });

    const newId = Number(Object.keys(rows).find((id) => rows[Number(id)].type === 'UsernameExact'));
    expect(newId).toBeGreaterThan(0);
    expect(recordModActivitySpy).toHaveBeenCalledWith({
      userId: MOD_ID,
      entityType: 'blocklist',
      entityId: newId,
      activity: 'add',
    });
  });

  it('records who removed entries, against the row that changed', async () => {
    await removeBlocklistItems({
      userId: MOD_ID,
      id: 1,
      type: 'EmailDomain',
      items: ['spam.example'],
    });

    expect(recordModActivitySpy).toHaveBeenCalledWith({
      userId: MOD_ID,
      entityType: 'blocklist',
      entityId: 1,
      activity: 'remove',
    });
  });

  it('records nothing when the write changed nothing', async () => {
    await upsertBlocklist({
      userId: MOD_ID,
      id: 1,
      type: 'EmailDomain',
      blocklist: ['spam.example'],
    });
    await removeBlocklistItems({
      userId: MOD_ID,
      id: 1,
      type: 'EmailDomain',
      items: ['never-added.example'],
    });

    expect(recordModActivitySpy).not.toHaveBeenCalled();
  });

  it('records nothing when the row belongs to another type', async () => {
    await expect(
      upsertBlocklist({
        userId: MOD_ID,
        id: 1,
        type: 'MessagePattern',
        blocklist: ['unfreeze your funds'],
      })
    ).rejects.toBeInstanceOf(BlocklistRowMismatchError);

    expect(recordModActivitySpy).not.toHaveBeenCalled();
  });
});

describe('which row the system enforces', () => {
  // `readBlocklistRow` decides this for every reader in three apps, and after this change it is the
  // ONLY caller of the cache populate — so a write busts the key and the very next read through
  // here pins a value for a month. Dropping its `orderBy` was invisible before this test.
  it('reads the LOWEST row of the type', async () => {
    addDuplicateEmailDomainRow();

    const dto = await getBlocklistDTO({ type: 'EmailDomain' });

    expect(dto.id).toBe(1);
    expect(dto.data).toEqual(['spam.example', 'junk.example', 'trash.example']);
    expect(orderBys, 'the read must order by id ASC').toContainEqual(['id', 'asc']);
  });
});

describe('the shared cache key', () => {
  it('is DELETED, never rewritten with a snapshot', async () => {
    // A snapshot write is an unserialised read-modify-write over the artifact every reader
    // enforces from, so two edits the row lock correctly serialised can still land their cache
    // writes in the other order and leave the loser's list under a month TTL. Deletes commute.
    await removeBlocklistItems({
      userId: MOD_ID,
      id: 1,
      type: 'EmailDomain',
      items: ['spam.example'],
    });

    expect(delSpy).toHaveBeenCalledWith('system:blocklist:EmailDomain');
    expect(
      setSpy,
      'a write must not repopulate the key it just invalidated'
    ).not.toHaveBeenCalled();
  });

  it('reports a failed bust instead of throwing over a committed write', async () => {
    // The row is already written. Throwing here tells the operator the write failed, and their
    // retry then finds the entry gone, gets "Nothing was removed", and reloads onto the stale
    // cache showing the chip still present.
    delSpy.mockRejectedValueOnce(new Error('redis down'));

    const { count, cacheStale } = await removeBlocklistItems({
      userId: MOD_ID,
      id: 1,
      type: 'EmailDomain',
      items: ['junk.example'],
    });

    expect(count).toBe(1);
    expect(cacheStale).toBe(true);
    expect(rows[1].data, 'the row still lost the entry').not.toContain('junk.example');
  });

  it('is not busted when the write changed nothing', async () => {
    await removeBlocklistItems({
      userId: MOD_ID,
      id: 1,
      type: 'EmailDomain',
      items: ['never-added.example'],
    });

    expect(delSpy).not.toHaveBeenCalled();
  });
});
