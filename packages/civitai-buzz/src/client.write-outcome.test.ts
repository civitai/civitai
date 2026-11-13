// vitest is the workspace root's dev dependency; package test files run from the root suite.
// eslint-disable-next-line import/no-extraneous-dependencies
import { describe, expect, it } from 'vitest';
import { BuzzApiError, writeMayHaveLanded } from './client';

const fetchFailed = (code: string) =>
  Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

describe('writeMayHaveLanded', () => {
  it.each([
    ['a refused connection', fetchFailed('ECONNREFUSED')],
    ['an unknown host', fetchFailed('ENOTFOUND')],
    ['a failed DNS lookup', fetchFailed('EAI_AGAIN')],
    ['a ledger 400', new BuzzApiError(400, 'Bad Request')],
    ['a ledger 404', new BuzzApiError(404, 'Not Found')],
    ['a ledger 429', new BuzzApiError(429, 'Too Many Requests')],
    [
      'a 400 wrapped by mapError',
      Object.assign(new Error('bad'), { cause: new BuzzApiError(400, 'Bad Request') }),
    ],
  ])('is false for %s: nothing can have committed', (_, error) => {
    expect(writeMayHaveLanded(error)).toBe(false);
  });

  it.each([
    ['the runtime headers timeout', fetchFailed('UND_ERR_HEADERS_TIMEOUT')],
    ['a reset socket', fetchFailed('ECONNRESET')],
    ['a TypeError with no cause', new TypeError('fetch failed')],
    ['a client deadline', new DOMException('timed out', 'TimeoutError')],
    ['an abort', new DOMException('aborted', 'AbortError')],
    ['a ledger 408', new BuzzApiError(408, 'Request Timeout')],
    ['a ledger 409', new BuzzApiError(409, 'Conflict')],
    ['a ledger 500', new BuzzApiError(500, 'Internal Server Error')],
    ['a ledger 503', new BuzzApiError(503, 'Service Unavailable')],
    [
      'a 503 wrapped by mapError',
      Object.assign(new Error('x'), { cause: new BuzzApiError(503, 'Service Unavailable') }),
    ],
    ['an unrecognised error', new Error('something else')],
    ['a thrown non-error', 'boom'],
    ['null', null],
  ])('is true for %s: the write may have committed', (_, error) => {
    expect(writeMayHaveLanded(error)).toBe(true);
  });
});
