import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageTagRow } from '~/server/redis/image-tag-rows';
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
  it('binds the whole id batch as ONE array parameter', async () => {
    await getImageTagRows(db, [31, 7, 1999]);
    const query = lastQuery();

    expect(query.values).toEqual([[31, 7, 1999]]);
    expect(normalise(query.text)).toBe(
      'SELECT "imageId", "source", "tagId" FROM "TagsOnImageDetails" ' +
        'WHERE "imageId" = ANY($1::int[]) AND "disabled" = false'
    );
  });

  it('sends identical statement text for every batch size', async () => {
    const texts: string[] = [];
    for (const size of [1, 2, 3, 50, 377]) {
      queryRaw.mockClear();
      const ids = Array.from({ length: size }, (_, i) => 1000 + i * 7);
      await getImageTagRows(db, ids);
      const query = lastQuery();
      expect(query.values).toHaveLength(1);
      expect(query.values[0]).toEqual(ids);
      texts.push(normalise(query.text));
    }
    expect(new Set(texts).size).toBe(1);
  });

  // Invariant guard: the function passes rows through untouched; column shape is pinned by the
  // statement-text test above.
  it('returns the rows unchanged', async () => {
    const rows: ImageTagRow[] = [
      { imageId: 31, source: 'WD14', tagId: 5 },
      { imageId: 31, source: 'Rekognition', tagId: 812 },
      { imageId: 7, source: 'User', tagId: 44 },
    ];
    queryRaw.mockResolvedValue(rows);

    const result = await getImageTagRows(db, [31, 7]);

    expect(result).toEqual([
      { imageId: 31, source: 'WD14', tagId: 5 },
      { imageId: 31, source: 'Rekognition', tagId: 812 },
      { imageId: 7, source: 'User', tagId: 44 },
    ]);
  });

  it('returns [] for an empty batch without querying', async () => {
    await expect(getImageTagRows(db, [])).resolves.toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
