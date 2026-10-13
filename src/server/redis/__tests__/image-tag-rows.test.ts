import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getImageTagRows } from '~/server/redis/image-tag-rows';

// The id batch must bind as a single array parameter so the statement text is batch-size-independent.

const queryRaw = vi.fn();
const db = { $queryRaw: queryRaw } as unknown as Parameters<typeof getImageTagRows>[0];

const normalise = (s: string) => s.replace(/\s+/g, ' ').trim();
// Builds the statement with Prisma's own `Prisma.sql`, which is what tagged `$queryRaw` does, so
// `.text`/`.values` are the SQL and bindings Prisma sends rather than a hand-joined template.
function lastQuery() {
  expect(queryRaw).toHaveBeenCalledTimes(1);
  const [strings, ...values] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
  return Prisma.sql(strings, ...values);
}

beforeEach(() => {
  queryRaw.mockReset().mockResolvedValue([]);
});

describe('getImageTagRows', () => {
  it('binds the whole id batch as ONE array parameter, with the same text at every batch size', async () => {
    for (const size of [1, 2, 3, 50, 377]) {
      queryRaw.mockClear();
      const ids = Array.from({ length: size }, (_, i) => 1000 + i * 7);
      await getImageTagRows(db, ids);
      const query = lastQuery();

      expect(query.values).toEqual([ids]);
      expect(normalise(query.text)).toBe(
        'SELECT "imageId", "source", "tagId" FROM "TagsOnImageDetails" ' +
          'WHERE "imageId" = ANY($1::int[]) AND "disabled" = false'
      );
    }
  });

  it('returns [] for an empty batch without querying', async () => {
    await expect(getImageTagRows(db, [])).resolves.toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
