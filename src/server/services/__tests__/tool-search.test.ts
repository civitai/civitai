import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// The /tools page's search (the header bar under pageSearch) is the list's `query`: a name or
// company match. It was in the schema but never reached the query.

import { getAllTools } from '~/server/services/tool.service';

const findMany = vi.mocked(dbMock.dbRead.tool.findMany);

beforeEach(() => {
  findMany.mockClear();
  findMany.mockResolvedValue([] as never);
});

const where = () => findMany.mock.calls[0][0]?.where;

describe('getAllTools query', () => {
  it('matches the name or company, ignoring case and surrounding spaces', async () => {
    await getAllTools({ query: '  comfy ' });
    expect(where().OR).toEqual([
      { name: { contains: 'comfy', mode: 'insensitive' } },
      { company: { contains: 'comfy', mode: 'insensitive' } },
    ]);
  });

  it('lists every tool without one', async () => {
    await getAllTools({ query: '   ' });
    expect(where()).not.toHaveProperty('OR');
  });
});
