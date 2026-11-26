import { beforeEach, describe, expect, it, vi } from 'vitest';

// Internal/External generation is moderator-managed, so the creator's usage-control writes must only
// touch Download/Generation rows. Each write-builder call returns a NEW builder carrying its clauses, so
// a WHERE dropped from the chain is missing from what `execute` records.
type Clause = unknown[];
const state = vi.hoisted(() => ({
  writes: [] as unknown[][][],
  gates: [] as unknown[],
  updatedRows: [] as { id: number }[],
}));

vi.mock('$lib/server/db', () => {
  const read: Record<string, unknown> = {};
  for (const m of ['selectFrom', 'innerJoin', 'where', 'select']) read[m] = () => read;
  read.execute = async () => state.gates;
  read.executeTakeFirst = async () => ({ count: '0' });

  const writeBuilder = (wheres: Clause[]): Record<string, unknown> => ({
    updateTable: () => writeBuilder(wheres),
    set: () => writeBuilder(wheres),
    where: (...args: Clause) => writeBuilder([...wheres, args]),
    returning: () => writeBuilder(wheres),
    execute: async () => {
      state.writes.push(wheres);
      return state.updatedRows;
    },
    executeTakeFirst: async () => {
      state.writes.push(wheres);
      return { numUpdatedRows: BigInt(state.updatedRows.length) };
    },
  });
  return { dbRead: read, dbWrite: writeBuilder([]) };
});
const { callMainApp } = vi.hoisted(() => ({ callMainApp: vi.fn() }));
vi.mock('$lib/server/main-app', () => ({ callMainApp }));
vi.mock('$env/dynamic/private', () => ({ env: {} }));

import { bulkSetUsageControl, setUsageControl } from '../monetization/paid-access';

const creatorSettable = ['usageControl', 'in', ['Download', 'Generation']];
// A Download-priced gate, which a switch to Generation moves onto the generation tier.
const downloadGate = (entityId: number) => ({
  entityId,
  timeframeDays: null,
  terms: { download: { price: 500 } },
});

beforeEach(() => {
  state.writes = [];
  state.gates = [];
  state.updatedRows = [{ id: 10 }];
  callMainApp.mockReset().mockResolvedValue({ ok: true });
});

describe('usage-control writes leave moderator-managed versions alone', () => {
  it('setUsageControl only updates a Download or Generation row', async () => {
    await setUsageControl(1, 10, 'Download', true);
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toContainEqual(creatorSettable);
  });

  it('bulkSetUsageControl only updates Download or Generation rows', async () => {
    await bulkSetUsageControl(1, [10, 11], 'Generation', 'cookie', true);
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toContainEqual(creatorSettable);
  });

  it('bulkSetUsageControl moves prices only for versions it updated, and counts the rest', async () => {
    // Version 11 is External: the WHERE leaves it out, so its gate must not be rewritten.
    state.gates = [downloadGate(10), downloadGate(11)];

    const result = await bulkSetUsageControl(1, [10, 11], 'Generation', 'cookie', true);

    expect(result).toMatchObject({ ok: true, updated: 1, skipped: 1, migrated: 1 });
    const migratedIds = callMainApp.mock.calls.map(([, , init]) => init.body.id);
    expect(migratedIds).toEqual([10]);
  });
});
