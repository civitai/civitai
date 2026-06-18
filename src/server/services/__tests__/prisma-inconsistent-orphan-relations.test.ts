import { beforeEach, describe, expect, it, vi } from 'vitest';

// The modules under test (model.service, article.selector → tag.selector, etc.)
// call `Prisma.validator<...>()(...)` and the `Prisma.sql`/`raw`/`join` tagged-
// template helpers at MODULE-LOAD (top-level consts). Under the unit vitest env
// the real `@prisma/client` is externalised and those runtime members aren't
// available at SSR import time → `Prisma.validator is not a function`. Mirror the
// house pattern (see block-registry.page-only-launch / showcase.service tests):
// stub `@prisma/client` with passthrough runtime helpers. A Proxy backs `Prisma`
// so any enum the wide import graph references at load resolves to a stub member
// instead of `undefined`, while the helpers we know the graph calls are real fns.
vi.mock('@prisma/client', () => {
  // `Prisma.validator<T>()(x)` → returns a function that returns its argument
  // unchanged, so the validated select/where object is preserved verbatim (the
  // tests assert against that exact shape).
  const validator = () => (x: unknown) => x;
  // Tagged-template SQL helpers used at module load by caches.ts / selectors.
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
    sql: strings.join('?'),
  });
  const raw = (s: string) => ({ sql: s, values: [] });
  const join = (values: unknown[], separator = ',') => ({ values, separator });
  const empty = { sql: '', values: [] };
  class Sql {}

  const known: Record<string, unknown> = {
    validator,
    sql,
    raw,
    join,
    empty,
    Sql,
    // Common Prisma sort/null constants referenced in selectors at load.
    SortOrder: { asc: 'asc', desc: 'desc' },
    QueryMode: { default: 'default', insensitive: 'insensitive' },
    JsonNull: 'JsonNull',
    DbNull: 'DbNull',
    AnyNull: 'AnyNull',
  };

  // Any other `Prisma.<member>` access (Prisma-generated enums referenced at
  // load time across the wide import graph) resolves to an empty object stub,
  // so module evaluation never trips over an undefined member.
  const Prisma = new Proxy(known, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return {};
    },
  });

  // Prisma-generated *enums* are exported as top-level named exports too
  // (e.g. `import { MediaType } from '@prisma/client'`). Back the whole module
  // with a Proxy: `Prisma` resolves above; any other named import (an enum)
  // resolves to an empty object stub.
  return new Proxy(
    { Prisma, PrismaClient: class PrismaClient {} },
    {
      get(target, prop: string) {
        if (prop in target) return (target as Record<string, unknown>)[prop];
        if (prop === '__esModule') return true;
        return {};
      },
    }
  );
});

/**
 * Regression tests for the "Inconsistent query result" 500s on
 * `model.getRecentlyManuallyAdded` and `article.getById`.
 *
 * Root cause (both): a Prisma `select` materialised a *required* to-one
 * relation on a row whose related record had been hard-deleted (orphaned FK).
 * Prisma cannot return `null` for a required relation, so it throws
 * "Inconsistent query result: Field <X> is required to return data, got null"
 * at query-execution time → HTTP 500. Measured in prod: ~1.2M orphaned
 * `ImageResourceNew.modelVersion` rows and 40 orphaned `TagsOnArticle.tag`
 * rows.
 *
 * Fix (both): add a relation-existence filter (`{ is: {} }`) so the DB drops
 * the orphan rows server-side and the query degrades gracefully (returns the
 * resolvable rows / empty) instead of erroring.
 */

// --- model.getRecentlyManuallyAdded ----------------------------------------
// The handler is a thin wrapper over a single dbRead.imageResourceNew.findMany,
// so we mock the db client and the env, and stub the (heavy) transitive imports
// of model.service that aren't exercised by this code path.

const findManyMock = vi.fn();

vi.mock('~/server/db/client', () => ({
  dbRead: { imageResourceNew: { findMany: findManyMock } },
  dbWrite: {},
}));

describe('getRecentlyManuallyAdded — orphaned ImageResourceNew.modelVersion', () => {
  beforeEach(() => {
    findManyMock.mockReset();
  });

  it('passes a relation-existence filter so orphaned modelVersion rows are excluded at the DB', async () => {
    findManyMock.mockResolvedValue([{ modelVersion: { modelId: 11 } }]);
    const { getRecentlyManuallyAdded } = await import('../model.service');

    await getRecentlyManuallyAdded({ take: 10, userId: 42 });

    expect(findManyMock).toHaveBeenCalledTimes(1);
    const args = findManyMock.mock.calls[0][0];
    // The load-bearing fix: a required-relation existence filter. Without it,
    // a row whose modelVersionId points at a deleted ModelVersion makes Prisma
    // throw and the whole query 500s.
    expect(args.where.modelVersion).toEqual({ is: {} });
  });

  it('returns the surviving modelIds (no throw) when the DB filters out the orphan rows', async () => {
    // Simulate the post-fix DB behaviour: the orphaned row (whose modelVersion
    // would be null) is excluded by the `{ is: {} }` filter, so findMany only
    // ever yields rows with a real modelVersion. The handler returns those.
    findManyMock.mockResolvedValue([
      { modelVersion: { modelId: 7 } },
      { modelVersion: { modelId: 7 } }, // dup → uniq
      { modelVersion: { modelId: 9 } },
    ]);
    const { getRecentlyManuallyAdded } = await import('../model.service');

    const result = await getRecentlyManuallyAdded({ take: 10, userId: 42 });
    expect(result).toEqual([7, 9]);
  });

  it('returns [] when the user has only orphaned resources (all filtered out)', async () => {
    // With the fix, an all-orphan result set comes back empty from the DB
    // instead of throwing "Inconsistent query result".
    findManyMock.mockResolvedValue([]);
    const { getRecentlyManuallyAdded } = await import('../model.service');

    const result = await getRecentlyManuallyAdded({ take: 10, userId: 42 });
    expect(result).toEqual([]);
  });
});

// --- article.getById (shared articleDetailSelect) --------------------------
// The article 500 comes from the `tags.tag` required relation in the shared
// `articleDetailSelect`, reused by getArticleById, getModeratorArticles, the
// search indexer, and the outbound webhook. The fix lives in the selector, so
// we assert the selector shape directly (a pure data object — no heavy imports).

describe('articleDetailSelect — orphaned TagsOnArticle.tag', () => {
  it('filters the tags relation on tag existence so orphaned join rows are excluded', async () => {
    const { articleDetailSelect } = await import('~/server/selectors/article.selector');

    // tags must carry a where-clause requiring the related Tag to exist; a
    // bare `{ select: { tag: ... } }` (no where) re-introduces the 500 because
    // TagsOnArticle.tag is a required relation with orphaned rows in prod.
    expect(articleDetailSelect.tags).toMatchObject({
      where: { tag: { is: {} } },
      select: { tag: { select: expect.anything() } },
    });
  });
});
