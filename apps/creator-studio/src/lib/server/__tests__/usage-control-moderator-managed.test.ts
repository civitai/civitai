import { beforeEach, describe, expect, it, vi } from 'vitest';

// Internal/External generation is moderator-managed, so the creator's usage-control writes must only
// touch Download/Generation rows. Each write-builder call returns a NEW builder carrying its clauses, so
// a WHERE dropped from the chain is missing from what `executeTakeFirst` records.
type Clause = unknown[];
const state = vi.hoisted(() => ({ writes: [] as unknown[][][] }));

vi.mock('$lib/server/db', () => {
  const read: Record<string, unknown> = {};
  for (const m of ['selectFrom', 'innerJoin', 'where', 'select']) read[m] = () => read;
  read.execute = async () => [];
  read.executeTakeFirst = async () => ({ count: '0' });

  const writeBuilder = (wheres: Clause[]): Record<string, unknown> => ({
    updateTable: () => writeBuilder(wheres),
    set: () => writeBuilder(wheres),
    where: (...args: Clause) => writeBuilder([...wheres, args]),
    executeTakeFirst: async () => {
      state.writes.push(wheres);
      return { numUpdatedRows: 1n };
    },
  });
  return { dbRead: read, dbWrite: writeBuilder([]) };
});
vi.mock('$lib/server/main-app', () => ({ callMainApp: vi.fn() }));
vi.mock('$env/dynamic/private', () => ({ env: {} }));

import { bulkSetUsageControl, setUsageControl } from '../monetization/paid-access';

const creatorSettable = ['usageControl', 'in', ['Download', 'Generation']];

beforeEach(() => {
  state.writes = [];
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
});
