import { describe, expect, it } from 'vitest';
import { getQueryErrorMessage } from '~/utils/errorHandling';

describe('getQueryErrorMessage', () => {
  it('replaces the raw parse failure a non-JSON body produces', () => {
    // What `TRPCClientError.from` builds when `res.json()` rejects: the SyntaxError's own
    // text as the message, the SyntaxError itself as the cause, and no `data`.
    const cause = new SyntaxError(
      `Failed to execute 'json' on 'Response': Unexpected token '<', "<!doctype "... is not valid JSON`
    );

    const result = getQueryErrorMessage({ message: cause.message, cause });

    expect(result).toBe(
      "Couldn't reach the server — it may be busy. Please try again in a moment."
    );
  });

  it('names the limit when the server was able to report one', () => {
    expect(getQueryErrorMessage({ message: 'RATE_LIMIT', data: { httpStatus: 429 } })).toBe(
      'Too many requests. Please wait a moment and try again.'
    );
  });

  it('passes a real server message through untouched', () => {
    expect(getQueryErrorMessage({ message: 'No Model with id 1', data: { httpStatus: 404 } })).toBe(
      'No Model with id 1'
    );
  });

  it('does not fire on a server message that merely reads like a parse failure', () => {
    const message = 'Unexpected token in your prompt template';

    expect(getQueryErrorMessage({ message, cause: new Error('upstream'), data: null })).toBe(
      message
    );
  });
});
