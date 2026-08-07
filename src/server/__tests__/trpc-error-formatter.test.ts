import { describe, expect, it } from 'vitest';

/**
 * The generation gate marks an overridable block by throwing with
 * `cause: { softBlock: true }`; `trpc.ts`'s errorFormatter lifts that onto
 * `data.softBlock` so the client can offer "Generate Anyway".
 *
 * ⚠️ This pins the LOGIC, not the wiring. The formatter body is replicated below
 * because importing `~/server/trpc` pulls the whole router context (db, redis,
 * auth) in at module scope — so deleting the real branch in `trpc.ts` still
 * leaves the suite green, and the button would stop rendering with no test
 * failing. Fails closed, but silently. Keep the copy in step with the original.
 */
function formatError(shape: Record<string, unknown>, error: { cause?: unknown }) {
  const cause = error.cause as { softBlock?: boolean } | undefined;
  if (cause?.softBlock === true) {
    return { ...shape, data: { ...(shape.data as object), softBlock: true } };
  }
  return shape;
}

const shape = { message: 'Your prompt was flagged: daughter', data: { code: 'BAD_REQUEST' } };

describe('trpc errorFormatter — softBlock lifting', () => {
  it('lifts cause.softBlock onto data', () => {
    const result = formatError(shape, { cause: { softBlock: true } }) as {
      data: { softBlock?: boolean; code?: string };
    };
    expect(result.data.softBlock).toBe(true);
    // The spread must not drop what tRPC already put on `data`.
    expect(result.data.code).toBe('BAD_REQUEST');
  });

  it.each([
    ['no cause', undefined],
    ['an Error cause', new Error('boom')],
    ['a string cause', 'boom'],
    ['a null cause', null],
    ['softBlock false', { softBlock: false }],
    ['a truthy non-boolean softBlock', { softBlock: 'yes' }],
  ])('leaves the shape untouched for %s', (_label, cause) => {
    const result = formatError(shape, { cause }) as { data: { softBlock?: boolean } };
    expect(result.data.softBlock).toBeUndefined();
  });
});
