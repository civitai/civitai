import { describe, expect, it } from 'vitest';
import { getCursorClauses } from '~/server/utils/pagination-helpers';

/**
 * `hotScore` is an `int` because `parseCursor` runs `parseInt` on numeric tokens: a
 * fractional score would be truncated, and every row inside that score's fractional range
 * silently skipped while paging. These fail if the column becomes a float, or if the parser
 * starts rounding.
 */
const HOT_SORT = 'mm."hotScore" DESC, mm."modelId"';

const valuesOf = (clause: unknown) => (clause as { values: unknown[] }).values;

describe('hot sort keyset cursor', () => {
  it('round-trips an integer score token unchanged', () => {
    const { strict, equality, prop } = getCursorClauses(HOT_SORT, '6940077|1234');

    expect(valuesOf(strict)).toEqual([6940077]);
    expect(valuesOf(equality)).toEqual([6940077, 1234]);
    // The server builds nextCursor from this expression, so it must name both sort fields
    // in order or the next page reads the wrong column.
    expect(prop).toBe(`CONCAT(mm."hotScore", '|', mm."modelId")`);
  });

  it('TRUNCATES a fractional score token — the reason the column is an int', () => {
    const { strict } = getCursorClauses(HOT_SORT, '6940077.6|1234');

    expect(valuesOf(strict)).toContain(6940077);
    expect(valuesOf(strict)).not.toContain(6940077.6);
  });

  it('rejects a malformed token instead of binding NaN into the comparison', () => {
    expect(() => getCursorClauses(HOT_SORT, '|1234')).toThrow();
  });

  it('rejects a cursor whose arity does not match the sort', () => {
    expect(() => getCursorClauses(HOT_SORT, '6940077')).toThrow();
  });

  it('splits the predicate so the index can seek, like the other DESC-led feed sorts', () => {
    const { splittable, strict, equality } = getCursorClauses(HOT_SORT, '6940077|1234');

    expect(splittable).toBe(true);
    expect(strict).toBeDefined();
    expect(equality).toBeDefined();
  });
});
