import { describe, it, expect } from 'vitest';

/**
 * Unit coverage for the envelope BUILDER itself (civitai#3845).
 *
 * Why a separate suite from the route/helper ones: at every real emit site the
 * `message` and `error` fields carry the SAME string (`restErrorBody(code, msg)`
 * defaults `error` to `msg`), so a route-level assertion cannot tell the two
 * apart — a mutation that blanks one, swaps them, or wires both to the same
 * source survives. Here they are given DELIBERATELY DISTINCT values, which is
 * what makes each field's placement independently observable.
 */

import {
  GENERIC_SERVER_ERROR_MESSAGE,
  REST_ERROR_CODE,
  restErrorBody,
} from '~/server/utils/rest-error-envelope';

describe('restErrorBody', () => {
  it('places DISTINCT `message` and `error` values in their own fields (no aliasing)', () => {
    const body = restErrorBody(REST_ERROR_CODE.NOT_FOUND, 'message-value', 'error-value');

    // Distinct on purpose: a swap, an alias, or a blanked field all fail here and
    // are indistinguishable at any real call site (where the two are equal).
    expect(body.message, '`message` must be the 2nd argument, verbatim').toBe('message-value');
    expect(body.error, '`error` must be the 3rd argument, verbatim').toBe('error-value');
    expect(body.code, '`code` must be the 1st argument, verbatim').toBe('NOT_FOUND');
  });

  it('defaults `error` to `message` — the retained-legacy-value rule', () => {
    const body = restErrorBody(REST_ERROR_CODE.NOT_FOUND, 'App not found');

    // The shipped Go CLI renders `error` IN PREFERENCE to `message`, so an empty
    // or omitted `error` blanks every CLI-visible error string. Assert the VALUE,
    // never mere key presence.
    expect(body.error, '`error` must default to the message, not to empty/undefined').toBe(
      'App not found'
    );
    expect(body.message).toBe('App not found');
  });

  it('accepts a NON-STRING `error` (the zod flatten object) while `message` stays a string', () => {
    const flattened = { formErrors: [], fieldErrors: { slug: ['Required'] } };
    const body = restErrorBody(REST_ERROR_CODE.BAD_REQUEST, 'Invalid slug', flattened);

    // The CLI's `badRequestDetail` special-cases this exact `{formErrors,
    // fieldErrors}` shape to render per-field errors; retyping it to a string
    // silently degrades every 400 the CLI prints.
    expect(body.error, '`error` must carry the flatten OBJECT through unchanged').toEqual(
      flattened
    );
    expect(typeof body.message, '`message` must remain a string for the CLI decoder').toBe(
      'string'
    );
  });

  it('emits EXACTLY the three contract keys — nothing more', () => {
    const body = restErrorBody(REST_ERROR_CODE.INTERNAL_SERVER_ERROR, GENERIC_SERVER_ERROR_MESSAGE);

    expect(Object.keys(body).sort(), 'the envelope is exactly {code, error, message}').toEqual([
      'code',
      'error',
      'message',
    ]);
  });

  it('the generic 500 text discloses NOTHING about the failure', () => {
    // Not a tautology on the constant's spelling: this asserts the PROPERTY the
    // constant exists for — no driver/table/column/stack vocabulary — so a future
    // edit that makes it "helpfully" specific fails here.
    for (const token of ['prisma', 'invocation', 'column', 'table', 'sql', 'database', 'stack']) {
      expect(
        GENERIC_SERVER_ERROR_MESSAGE.toLowerCase(),
        `the generic 500 text must not mention ${JSON.stringify(token)}`
      ).not.toContain(token);
    }
  });
});
