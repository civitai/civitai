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

  // An orchestrator 4xx hands back its parsed problem-details body, a plain object. String()
  // of that is "[object Object]", which logged nothing about why the submit was rejected.
  it('serializes a plain object to readable JSON text', () => {
    const body = { title: 'Bad Request', status: 400, detail: 'mediaUrl is not reachable' };
    const out = safeError(body)!;
    expect(out.message).not.toBe('[object Object]');
    expect(JSON.parse(out.message)).toEqual(body);
  });

  it('redacts credential-shaped keys at any depth', () => {
    const out = safeError({
      detail: 'denied',
      headers: { Authorization: 'Bearer abc', Cookie: 'sid=1' },
      config: { apiKey: 'k', password: 'p', clientSecret: 's', access_token: 't' },
    })!;
    for (const secret of ['Bearer abc', 'sid=1', '"k"', '"p"', '"s"', '"t"'])
      expect(out.message).not.toContain(secret);
    expect(out.message).toContain('denied');
  });

  it('caps the serialized text and survives values JSON cannot encode', () => {
    expect(safeError({ detail: 'x'.repeat(10_000) })!.message.length).toBeLessThanOrEqual(2_000);
    const circular: Record<string, unknown> = { detail: 'loop' };
    circular.self = circular;
    expect(safeError(circular)).toEqual({ message: '[object Object]' });
    expect(JSON.parse(safeError({ n: BigInt(1) })!.message)).toEqual({ n: '1' });
    const bare = Object.create(null) as Record<string, unknown>;
    bare.self = bare;
    expect(safeError(bare)).toEqual({ message: '[unserializable object]' });
  });
});
