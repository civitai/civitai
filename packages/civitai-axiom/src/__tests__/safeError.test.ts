import { describe, expect, it } from 'vitest';
import { safeError } from '../client';

// Pins `safeError`'s contract: primitive-only extraction (no schema-blowup keys), and the two
// nested-error shapes it unwraps — `.cause` (JS-native) and `.inner` (@node-oauth/oauth2-server's
// ServerError wraps the real failure here, so the top-level name/message/stack are the generic
// library frame). The `.inner` unwrap is load-bearing for triaging wrapped auth 500s.

describe('safeError', () => {
  it('returns undefined for null/undefined', () => {
    expect(safeError(null)).toBeUndefined();
    expect(safeError(undefined)).toBeUndefined();
  });

  it('stringifies non-Error values', () => {
    expect(safeError('boom')).toEqual({ message: 'boom' });
    expect(safeError(42)).toEqual({ message: '42' });
  });

  it('extracts only safe primitives from a plain Error', () => {
    const e = Object.assign(new Error('bad'), { code: 'E_BAD' });
    const out = safeError(e)!;
    expect(out.name).toBe('Error');
    expect(out.message).toBe('bad');
    expect(out.code).toBe('E_BAD');
    expect(typeof out.stack).toBe('string');
    // no cause/inner present → those fields are undefined (dropped by JSON.stringify)
    expect(out.causeMessage).toBeUndefined();
    expect(out.innerName).toBeUndefined();
    expect(out.innerMessage).toBeUndefined();
    expect(out.innerStack).toBeUndefined();
  });

  it('captures the message of a JS-native .cause', () => {
    const e = new Error('outer', { cause: new Error('the root cause') });
    expect(safeError(e)!.causeMessage).toBe('the root cause');
  });

  it('unwraps oauth2-server-style .inner (name + message + stack)', () => {
    // Shape of @node-oauth/oauth2-server ServerError: generic top-level, real failure in .inner.
    const realFailure = new Error('column "foo" does not exist');
    realFailure.name = 'DatabaseError';
    const wrapped = Object.assign(new Error('Internal Server Error'), {
      name: 'server_error',
      code: 500,
      inner: realFailure,
    });

    const out = safeError(wrapped)!;
    // top-level stays the generic library frame...
    expect(out.name).toBe('server_error');
    expect(out.code).toBe(500);
    // ...but the real cause is now recoverable for pager triage.
    expect(out.innerName).toBe('DatabaseError');
    expect(out.innerMessage).toBe('column "foo" does not exist');
    expect(out.innerStack).toContain('column "foo" does not exist');
  });

  it('handles a non-Error .inner by stringifying its message', () => {
    const wrapped = Object.assign(new Error('wrap'), { inner: 'raw string failure' });
    const out = safeError(wrapped)!;
    expect(out.innerMessage).toBe('raw string failure');
    expect(out.innerName).toBeUndefined();
    expect(out.innerStack).toBeUndefined();
  });
});
