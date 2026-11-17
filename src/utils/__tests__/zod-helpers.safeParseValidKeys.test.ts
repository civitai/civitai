import * as z from 'zod';
import { describe, expect, it } from 'vitest';
import { numericString, safeParseValidKeys } from '~/utils/zod-helpers';

describe('safeParseValidKeys', () => {
  it('keeps going until every failing key is gone', () => {
    // `b` only fails once `a` is gone, so a single strip-and-retry would still fail.
    const schema = z
      .object({ a: z.string(), b: z.string(), c: z.string() })
      .partial()
      .superRefine((value, ctx) => {
        if (value.b && !value.a)
          ctx.addIssue({ code: 'custom', path: ['b'], message: 'b needs a' });
      });

    expect(safeParseValidKeys(schema, { a: 1, b: 'x', c: 'kept' })).toEqual({ c: 'kept' });
  });

  it('returns {} when a failure names no key of the input', () => {
    const schema = z
      .object({ a: z.string() })
      .partial()
      .superRefine((_, ctx) => ctx.addIssue({ code: 'custom', message: 'root' }));

    expect(safeParseValidKeys(schema, { a: 'x' })).toEqual({});
  });

  it('drops only the junk key', () => {
    const schema = z.object({ postId: numericString(), query: z.string() }).partial();
    expect(safeParseValidKeys(schema, { postId: 'null', query: 'castle' })).toEqual({
      query: 'castle',
    });
  });
});
