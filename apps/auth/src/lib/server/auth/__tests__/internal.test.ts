import { describe, it, expect, beforeEach } from 'vitest';
import { isInternalRequest } from '../internal';

// `$env/dynamic/private` is aliased to a process.env-backed stub (vitest.config.ts), so set the token there.
const req = (auth?: string) =>
  new Request('http://h/api', { headers: auth ? { authorization: auth } : {} });

describe('isInternalRequest', () => {
  beforeEach(() => {
    process.env.AUTH_INTERNAL_TOKEN = 'secret-123';
  });

  it('accepts a matching Bearer token', () => {
    expect(isInternalRequest(req('Bearer secret-123'))).toBe(true);
    expect(isInternalRequest(req('bearer secret-123'))).toBe(true); // case-insensitive scheme
  });

  it('rejects a wrong / missing token', () => {
    expect(isInternalRequest(req('Bearer nope'))).toBe(false);
    expect(isInternalRequest(req())).toBe(false);
    expect(isInternalRequest(req('secret-123'))).toBe(false); // no Bearer scheme
  });

  it('fails closed when no internal token is configured', () => {
    delete process.env.AUTH_INTERNAL_TOKEN;
    expect(isInternalRequest(req('Bearer secret-123'))).toBe(false);
    expect(isInternalRequest(req('Bearer '))).toBe(false);
  });
});
