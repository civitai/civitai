import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getImageTagRows } from '~/server/redis/image-tag-rows';

// The id batch must bind as a single array parameter so the statement text is batch-size-independent.
// What the statement returns, against real rows, is pinned in image-tag-rows.sql.behavior.test.ts.

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

      expect(query.values).toEqual([
        ids,
        ['anime', 'cartoon', 'comics', 'manga', 'man', 'woman', 'men', 'women'],
      ]);
      expect(normalise(query.text)).toBe(
        'SELECT toi."imageId", toi."source", toi."tagId" FROM "TagsOnImageDetails" toi ' +
          'WHERE toi."imageId" = ANY($1::int[]) AND toi."disabled" = false ' +
          'AND NOT ( toi."source" = \'Rekognition\' AND EXISTS ( ' +
          'SELECT 1 FROM "TagsOnImageDetails" wd ' +
          'WHERE wd."imageId" = toi."imageId" AND wd."source" = \'WD14\' AND wd."disabled" = false ) ' +
          'AND EXISTS ( SELECT 1 FROM "Tag" t ' +
          "WHERE t.id = toi.\"tagId\" AND t.type <> 'Moderation' AND t.name::text <> '' " +
          'AND t.name::text <> ALL($2::text[]) ) )'
      );
    }
  });

  it('returns [] for an empty batch without querying', async () => {
    await expect(getImageTagRows(db, [])).resolves.toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
