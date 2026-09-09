import { describe, expect, it } from 'vitest';

import {
  decodeOwnedToken,
  encodeOwnedToken,
} from '~/server/orchestrator/orchestrator-token-identity';

/**
 * The encode/decode pair is the whole of the in-app half of the cross-user identity
 * guard, so the case that matters most is the one that must NEVER return a token: a
 * value bound to a different user.
 */
describe('decodeOwnedToken', () => {
  it('returns the token when it is bound to the requesting user', () => {
    expect(decodeOwnedToken(encodeOwnedToken(42, 'abc123'), 42)).toEqual({
      token: 'abc123',
      outcome: 'ok',
    });
  });

  it('REFUSES a token bound to a different user, and names the owner it found', () => {
    const result = decodeOwnedToken(encodeOwnedToken(999, 'someone-elses-token'), 42);

    expect(result.token).toBeNull();
    expect(result.outcome).toBe('mismatch');
    expect(result.ownerId).toBe('999');
  });

  it('does not confuse a prefix that merely starts with the userId', () => {
    // `4` must not satisfy a request for user 42, nor 42 a request for user 4.
    expect(decodeOwnedToken(encodeOwnedToken(4, 't'), 42).outcome).toBe('mismatch');
    expect(decodeOwnedToken(encodeOwnedToken(42, 't'), 4).outcome).toBe('mismatch');
  });

  it('splits on the FIRST separator, so a token containing one still decodes', () => {
    expect(decodeOwnedToken('42.a.b.c', 42)).toEqual({ token: 'a.b.c', outcome: 'ok' });
  });

  // Both shapes an untaught writer can produce. Kept distinct from `mismatch` so such a
  // writer degrades to an ordinary miss rather than paging on a series that means "someone
  // is being billed for someone else's generation".
  it.each([
    ['no separator at all', 'bare-token-from-an-untaught-writer'],
    // Passes for the wrong reason if only the case above is tested: this one HAS a
    // separator, and without the numeric-prefix check it reports `mismatch` with
    // `ownerId: 'sess'` and fires the alarm.
    ['a separator but a non-numeric prefix', 'sess.abc123'],
  ])('treats %s as a miss, not a mismatch', (_label, value) => {
    expect(decodeOwnedToken(value, 42)).toEqual({ token: null, outcome: 'unowned' });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
  ])('reports %s as absent', (_label, value) => {
    expect(decodeOwnedToken(value as string | null | undefined, 42)).toEqual({
      token: null,
      outcome: 'absent',
    });
  });
});
