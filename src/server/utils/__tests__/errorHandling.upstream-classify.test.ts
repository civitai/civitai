import { describe, it, expect } from 'vitest';
import {
  isUpstreamNetworkError,
  isUpstreamServerOrNetworkError,
} from '~/server/utils/errorHandling';

// Pure classifier tests — these gate whether an orchestrator-client failure is
// treated as a transient upstream outage (→ 503) vs. left to surface as a 500.
// They have no env/Prisma dependencies beyond the module under test.

describe('isUpstreamNetworkError', () => {
  it('matches the canonical undici "fetch failed" TypeError', () => {
    const err = new TypeError('fetch failed');
    expect(isUpstreamNetworkError(err)).toBe(true);
  });

  it('matches a fetch failed whose syscall is nested under .cause', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), {
      code: 'ECONNREFUSED',
    });
    const err = Object.assign(new TypeError('fetch failed'), { cause });
    expect(isUpstreamNetworkError(err)).toBe(true);
  });

  it.each([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
  ])('matches a top-level error carrying network code %s', (code) => {
    const err = Object.assign(new Error('socket error'), { code });
    expect(isUpstreamNetworkError(err)).toBe(true);
  });

  it('matches an AbortError / request-timeout with no HTTP status', () => {
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    expect(isUpstreamNetworkError(abort)).toBe(true);
    const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    expect(isUpstreamNetworkError(timeout)).toBe(true);
  });

  it('does NOT match a genuine application bug (plain TypeError from our code)', () => {
    // e.g. `Cannot read properties of undefined (reading 'status')` thrown by a
    // real bug in our mapping logic — must stay a 500, never be 503'd.
    const bug = new TypeError("Cannot read properties of undefined (reading 'foo')");
    expect(isUpstreamNetworkError(bug)).toBe(false);
  });

  it('does NOT match an arbitrary Error / a 4xx-ish detail string', () => {
    expect(isUpstreamNetworkError(new Error('Bad Request'))).toBe(false);
    expect(isUpstreamNetworkError(new Error('Internal Server Error'))).toBe(false);
    expect(isUpstreamNetworkError('some string')).toBe(false);
    expect(isUpstreamNetworkError(undefined)).toBe(false);
    expect(isUpstreamNetworkError(null)).toBe(false);
  });

  it('does not infinite-loop on a self-referential cause chain', () => {
    const err: any = new Error('weird');
    err.cause = err;
    expect(isUpstreamNetworkError(err)).toBe(false);
  });
});

describe('isUpstreamServerOrNetworkError', () => {
  it('treats an upstream HTTP status >= 500 as upstream fault', () => {
    expect(isUpstreamServerOrNetworkError({ clientError: { status: 500 } })).toBe(true);
    expect(isUpstreamServerOrNetworkError({ clientError: { status: 502 } })).toBe(true);
    expect(isUpstreamServerOrNetworkError({ clientError: { status: 503 } })).toBe(true);
  });

  it('does NOT treat a 4xx as an upstream fault (keep mapped client code)', () => {
    expect(isUpstreamServerOrNetworkError({ clientError: { status: 400 } })).toBe(false);
    expect(isUpstreamServerOrNetworkError({ clientError: { status: 404 } })).toBe(false);
    expect(isUpstreamServerOrNetworkError({ clientError: { status: 429 } })).toBe(false);
  });

  it('treats a status-less thrown network failure as upstream fault', () => {
    expect(isUpstreamServerOrNetworkError({ thrown: new TypeError('fetch failed') })).toBe(true);
  });

  it('does NOT treat a status-less unexpected throw (real bug) as upstream fault', () => {
    expect(
      isUpstreamServerOrNetworkError({ thrown: new TypeError('x is not a function') })
    ).toBe(false);
    expect(isUpstreamServerOrNetworkError({ clientError: null })).toBe(false);
    expect(isUpstreamServerOrNetworkError({})).toBe(false);
  });
});
