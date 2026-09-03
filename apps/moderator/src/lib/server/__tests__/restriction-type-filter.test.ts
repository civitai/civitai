import { describe, expect, it, vi } from 'vitest';

/**
 * `UserRestriction.type` is what separates one review queue from another. The rows carry no other
 * marker — same table, same status vocabulary, same shape — so if the predicate is dropped, weakened,
 * or bound to the wrong value, one queue simply renders another's cases and a moderator rules on them
 * under the wrong assumptions.
 *
 * 🔴 Asserted against the COMPILED SQL **and its bound parameters**. The text alone cannot see the bug
 * this file exists for: `where('ur.type','=',x)` emits `"ur"."type" = $1` whatever `x` is, so a version
 * that ignores its argument and always filters `generation` produces byte-identical SQL. The parameter
 * is the only place the difference is visible.
 *
 * The count query is checked alongside the row query on purpose — they are separately compiled off a
 * shared builder, and a filter that reaches one but not the other gives a pager whose total counts
 * every type's rows.
 */

const captured = vi.hoisted(() => [] as string[]);
const capturedParams = vi.hoisted(() => [] as unknown[][]);

// Built inside the factory, not in `vi.hoisted`: hoisted blocks run before this file's own imports, so
// constructing the client there reads it before initialisation.
vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  const db = capturingDb(captured, [], capturedParams);
  return { dbRead: db, dbWrite: db };
});

const { getGenerationRestrictions, RESTRICTION_TYPE } = await import('../user-restriction.service');

type Compiled = { sql: string; params: unknown[] };

const compile = async (
  query: Parameters<typeof getGenerationRestrictions>[0]
): Promise<Compiled[]> => {
  captured.length = 0;
  capturedParams.length = 0;
  await getGenerationRestrictions(query);
  // 🔴 Assert the COUNT, not just the contents. A chain that stops early leaves `captured` short while
  // every assertion over what IS in it still passes — on a query that was never built.
  expect(captured).toHaveLength(2);
  return captured.map((sql, i) => ({ sql, params: capturedParams[i] }));
};

const base = { page: 1, limit: 20 } as const;

/** The `ur.type` predicate's bound value, or `undefined` if the query emitted no such predicate. */
const boundType = ({ sql, params }: Compiled): unknown => {
  const match = /"ur"\."type" = \$(\d+)/.exec(sql);
  return match ? params[Number(match[1]) - 1] : undefined;
};

describe('getGenerationRestrictions — type scoping', () => {
  it('filters on the generation type when the caller names none', async () => {
    const compiled = await compile({ ...base });

    // Both statements, not just the first: the second is the pager's total.
    for (const c of compiled) expect(boundType(c)).toBe('generation');
    expect(RESTRICTION_TYPE).toBe('generation');
  });

  it('filters on the type it was given', async () => {
    const compiled = await compile({ ...base, type: 'bot-account' });

    for (const c of compiled) expect(boundType(c)).toBe('bot-account');
  });

  // 🔴 The leak, stated as a property rather than as one example: whatever type is asked for, no other
  // type's rows can satisfy the query. A predicate bound to the requested value is what guarantees it.
  it.each(['generation', 'bot-account'] as const)(
    'binds %s and no other type, in both the list and the count',
    async (type) => {
      const compiled = await compile({ ...base, type });

      for (const c of compiled) {
        expect(boundType(c)).toBe(type);
        // Exactly one type PREDICATE — a second, differently-bound one would AND/OR in another queue.
        // Matched with the `= $n` so this counts predicates and not the `ur.type` in the SELECT list.
        expect(c.sql.match(/"ur"\."type" = \$\d+/g)).toHaveLength(1);
      }
    }
  );

  it('keeps the type predicate when other filters are also applied', async () => {
    // The type predicate is unconditional while the rest are `$if`s. A refactor that folded it in with
    // them is exactly how it would go missing, and only a query carrying both shapes can see that.
    const compiled = await compile({
      ...base,
      type: 'bot-account',
      status: 'Pending',
      username: 'someone',
    });

    for (const c of compiled) {
      expect(boundType(c)).toBe('bot-account');
      expect(c.sql).toMatch(/"ur"\."status" = \$/);
    }
  });

  /**
   * The one caller allowed past the filter: a lookup by primary key. A form posts to `?/resolve`, which
   * replaces the query string, so an action never learns which queue the moderator was in — filtering a
   * by-id lookup by the DEFAULT type would 404 every row outside it. A primary key cannot be made more
   * correct by a type predicate, so the predicate is dropped rather than guessed.
   */
  it("drops the predicate only for the explicit 'any'", async () => {
    const compiled = await compile({ ...base, type: 'any', restrictionId: 7 });

    for (const c of compiled) {
      expect(boundType(c)).toBeUndefined();
      // The PREDICATE is gone. `ur.type` still appears in the row query's SELECT list, which is what
      // lets the caller read back the type it did not filter on.
      expect(c.sql).not.toMatch(/"ur"\."type" = \$/);
      expect(c.sql).toMatch(/"ur"\."id" = \$/);
    }
  });

  it('selects the row type, so a caller can tell what it got back', async () => {
    // `restrictionById` reads it to decide whether a ruling is wired for the row; without it in the
    // SELECT that check silently compares against `undefined`.
    const [list] = await compile({ ...base });

    expect(list.sql).toMatch(/"ur"\."type"[,\s]/);
  });
});
