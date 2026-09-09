import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';

vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getCategoryTags: async () => [],
}));

import { ArticleSort } from '~/server/common/enums';
import { getArticles } from '~/server/services/article.service';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';

// The fields `getArticles` reads unconditionally. Only `isOfficial` varies below.
const base = { limit: 10, sort: ArticleSort.Newest, period: MetricTimeframe.AllTime };

/**
 * The `?isOfficial=true` feed filter, asserted on the SQL the service emits.
 *
 * Reading the emitted statement rather than the arguments is deliberate: the filter is a
 * WHERE clause, and a test that only checked the service was CALLED with `isOfficial`
 * would pass for a service that accepted the flag and ignored it — which is exactly what
 * "filter does nothing" looks like to a user.
 */
function emittedSql() {
  const calls = dbMock.dbRead.$queryRaw.mock.calls as unknown[][];

  // Two things had to be learned here, and both are why this helper is not a one-liner.
  //
  // 1. `$queryRaw` is called as a TAGGED TEMPLATE, so the first argument is the
  //    TemplateStringsArray, not a `Prisma.Sql`.
  // 2. The WHERE clause is INTERPOLATED — `Prisma.join(AND)` arrives as a value, not as
  //    template text — so the filter this file is about does not appear in the strings at
  //    all. Reading only the strings returned SQL that could never contain the clause,
  //    and the negative assertions below passed against it happily.
  const render = (value: unknown): string => {
    if (value == null) return '';
    if (Array.isArray(value)) return value.map(render).join(' ');
    if (typeof value === 'object') {
      const sql = value as { strings?: unknown; sql?: string; values?: unknown };
      return [render(sql.strings), sql.sql ?? '', render(sql.values)].join(' ');
    }
    return String(value);
  };

  return calls.map((args) => render(args)).join('\n');
}

describe('getArticles — isOfficial filter', () => {
  beforeEach(() => {
    dbMock.dbRead.$queryRaw.mockReset();
    dbMock.dbRead.$queryRaw.mockResolvedValue([]);
  });

  it('narrows to official articles when asked', async () => {
    await getArticles({ ...base, isOfficial: true } as never);

    expect(emittedSql()).toContain('"isOfficial" = true');
  });

  // The control. Without it the assertion above passes for a service that hardcodes the
  // clause into every article feed on the site — which would hide all community content.
  it('does not narrow when the filter is absent', async () => {
    await getArticles({ ...base } as never);

    // The SQL really was captured — without this, the negative above passes when the
    // helper returns nothing, which is how it was written the first time.
    expect(emittedSql()).toContain('FROM "Article" a');
    expect(emittedSql()).not.toContain('"isOfficial" = true');
  });

  // 🔴 `false` is NOT the inverse, deliberately. Nobody browses FOR community articles,
  // and treating `false` as a filter would let a stale `?isOfficial=false` in somebody's
  // url quietly hide every official article from their feed. The schema comment says the
  // same thing; this is what enforces it.
  it('treats an explicit false as no filter, not as “community only”', async () => {
    await getArticles({ ...base, isOfficial: false } as never);

    expect(emittedSql()).toContain('FROM "Article" a');
    expect(emittedSql()).not.toContain('"isOfficial" = false');
    expect(emittedSql()).not.toContain('"isOfficial" = true');
  });
});
