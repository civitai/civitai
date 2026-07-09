import { describe, it, expect } from 'vitest';
import { now, elapsed, isTimeoutError } from '../timing';

describe('timing helpers', () => {
  it('now() is monotonic and elapsed() returns non-negative seconds', () => {
    const start = now();
    expect(elapsed(start)).toBeGreaterThanOrEqual(0);
    expect(elapsed(start)).toBeLessThan(5); // this test does not take 5s
  });

  describe('isTimeoutError', () => {
    it('classifies the identity-fetch AbortSignal.timeout DOMException (name TimeoutError)', () => {
      // What AbortSignal.timeout(...) throws through fetch.
      const err = Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
      expect(isTimeoutError(err)).toBe(true);
    });

    it('classifies the jose JWKS refetch timeout (name JWKSTimeout)', () => {
      expect(isTimeoutError(Object.assign(new Error('x'), { name: 'JWKSTimeout' }))).toBe(true);
    });

    it('classifies the jose JWKS timeout by code ERR_JWKS_TIMEOUT', () => {
      expect(isTimeoutError(Object.assign(new Error('x'), { code: 'ERR_JWKS_TIMEOUT' }))).toBe(true);
    });

    it('does NOT classify ordinary errors (bad signature, network reset, undefined) as timeouts', () => {
      expect(isTimeoutError(new Error('bad signature'))).toBe(false);
      expect(isTimeoutError(Object.assign(new Error('reset'), { name: 'TypeError' }))).toBe(false);
      expect(isTimeoutError(undefined)).toBe(false);
      expect(isTimeoutError('nope')).toBe(false);
    });
  });
});
