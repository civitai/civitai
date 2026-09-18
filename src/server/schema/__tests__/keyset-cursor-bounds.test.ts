import { describe, expect, it } from 'vitest';
import { INT4_MAX, keysetCursorSchema } from '~/server/schema/base.schema';
import { getAllModelsSchema } from '~/server/schema/model.schema';

/**
 * A keyset cursor is always a value THIS server issued as the previous page's
 * `nextCursor` — a bare column value for a single-field sort, or a
 * `CONCAT(col, '|', …)` string otherwise. The single-field keyset sorts here
 * order by `int` columns — mostly ids (`i."id"`, `ci."id"`, …), but NOT only
 * ids: `i."index"` is an `int` column that is neither an id nor 1-based. The set
 * was not exhaustively enumerated, so read this as the reason for the UPPER
 * bound and not as a closed inventory. A numeric cursor above Postgres `int4`
 * can only be client garbage. Unbounded, it bound straight into the SQL
 * comparison and Postgres threw `value out of range for type integer` — a raw
 * 500 for a client fault. Same class and same bound as the
 * `/api/v1/models/[id]` id schema.
 *
 * The companion arity guard (a bare number where the sort needs N values, which
 * is what produced the `date/time field value out of range` 500 on
 * `model.getAll`) lives in `src/server/utils/pagination-helpers.ts` and is
 * pinned in `src/server/utils/pagination-helpers.test.ts` — no magnitude bound
 * can catch that one, because the offending values are ordinary in-range ints.
 *
 * 🔴 Neither this bound nor that guard closes the COMPOSITE-STRING shape of the
 * same fault (`"165997|123"` on a date-headed sort). That residual is open and
 * is pinned as such in `src/server/utils/pagination-helpers.test.ts`.
 */

describe('keysetCursorSchema — numeric bound', () => {
  it.each([
    ['int4 max + 1', INT4_MAX + 1],
    ['a 12-digit value', 999999999999],
    ['a 13-digit value', 3086153086153],
    ['the largest exactly-representable JS integer', Number.MAX_SAFE_INTEGER],
  ])('rejects %s', (_label, value) => {
    expect(keysetCursorSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    ['a negative id', -5],
    ['a non-integer', 1.5],
  ])('rejects %s', (_label, value) => {
    expect(keysetCursorSchema.safeParse(value).success).toBe(false);
  });

  // 0 is a value this server can ISSUE, so the floor is `.gte(0)`, not `.gt(0)`.
  // `getInfiniteImagesSchema.limit` is `z.number().min(0)`, so `limit: 0` parses;
  // with a `postId` that routes to the DB path (`requiresImageDbPath`), whose
  // sort is `orderBy = i."index"` ASC (`image.service.ts`). The query runs
  // `LIMIT limit + 1` = 1, and `rawImages.length (1) > limit (0)` makes the
  // first row the `nextCursor` — its `cursorId` being `i."index"` itself.
  // `reorderPostImages` (`post.service.ts`) writes `imageIds.map((id, index) =>
  // … data: { index })`, so on a reordered post the first row's index is 0.
  it('accepts zero, which the limit:0 postId path can issue as a nextCursor', () => {
    expect(keysetCursorSchema.safeParse(0).success).toBe(true);
  });

  it.each([
    ['a real id', 2686725],
    ['the smallest id', 1],
    ['int4 max itself', INT4_MAX],
  ])('accepts %s', (_label, value) => {
    const result = keysetCursorSchema.safeParse(value);
    expect(result.success).toBe(true);
    expect(result.data).toBe(value);
  });

  it('rejects an out-of-range bigint', () => {
    expect(keysetCursorSchema.safeParse(BigInt(INT4_MAX) + BigInt(1)).success).toBe(false);
  });

  it('accepts an in-range bigint', () => {
    expect(keysetCursorSchema.safeParse(BigInt(2686725)).success).toBe(true);
  });

  // The bigint and number members must share a floor, or `0` parses as a number
  // and 400s as a bigint — the same value, the same sort column, two answers.
  it('accepts bigint zero, matching the number member', () => {
    expect(keysetCursorSchema.safeParse(BigInt(0)).success).toBe(true);
  });

  it('rejects a negative bigint', () => {
    expect(keysetCursorSchema.safeParse(BigInt(-5)).success).toBe(false);
  });

  // A string cursor is deliberately unbounded here. Downstream, `parseCursor`
  // checks the token COUNT and each token's PARSEABILITY — NOT that a token's
  // type matches the column it will be compared against. See the documented
  // residual in pagination-helpers.test.ts.
  it('leaves a composite string cursor untouched', () => {
    const result = keysetCursorSchema.safeParse('2024-01-15 12:00:00|2686725');
    expect(result.success).toBe(true);
    expect(result.data).toBe('2024-01-15 12:00:00|2686725');
  });

  it('still transforms a strict-ISO string cursor into a Date', () => {
    const result = keysetCursorSchema.safeParse('2024-01-15T12:00:00.000Z');
    expect(result.success).toBe(true);
    expect(result.data).toBeInstanceOf(Date);
    expect((result.data as Date).toISOString()).toBe('2024-01-15T12:00:00.000Z');
  });

  it('passes a Date cursor through unchanged', () => {
    const d = new Date('2024-01-15T12:00:00.000Z');
    const result = keysetCursorSchema.safeParse(d);
    expect(result.success).toBe(true);
    expect(result.data).toBeInstanceOf(Date);
  });
});

describe('getAllModelsSchema.cursor — bound end to end', () => {
  it('rejects an out-of-range numeric cursor at the procedure input boundary', () => {
    const result = getAllModelsSchema.safeParse({ cursor: Number.MAX_SAFE_INTEGER });
    expect(result.success).toBe(false);
    // The failure has to be attributed to `cursor`, not some other field, or the
    // 400 message is useless to the caller.
    expect(result.error?.issues.some((i) => i.path[0] === 'cursor')).toBe(true);
  });

  it('accepts the in-range production values (they fail LATER, on arity, with a 400)', () => {
    // 165997 / 493785 are ordinary ids: the magnitude bound must NOT be what
    // rejects them, or this test would be claiming coverage the bound
    // structurally cannot provide. See pagination-helpers.test.ts.
    for (const value of [165997, 493785]) {
      expect(getAllModelsSchema.safeParse({ cursor: value }).success).toBe(true);
    }
  });

  it('accepts a composite string cursor', () => {
    expect(getAllModelsSchema.safeParse({ cursor: '2024-01-15 12:00:00|2686725' }).success).toBe(
      true
    );
  });

  it('accepts no cursor at all', () => {
    expect(getAllModelsSchema.safeParse({}).success).toBe(true);
  });
});
