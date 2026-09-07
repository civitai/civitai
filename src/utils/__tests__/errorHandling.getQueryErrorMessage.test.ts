import { describe, expect, it } from 'vitest';
import { getQueryErrorMessage } from '~/utils/errorHandling';

describe('getQueryErrorMessage', () => {
  // Verbatim messages from a non-JSON body reaching `res.json()`.
  it.each([
    `Unexpected token '<', "<!doctype "... is not valid JSON`,
    'JSON.parse: unexpected character at line 1 column 1 of the JSON data',
    'Unexpected end of JSON input',
  ])('replaces the raw parse failure %#', (message) => {
    const result = getQueryErrorMessage({ message });

    expect(result).not.toContain('doctype');
    expect(result).not.toContain('JSON');
    expect(result).toBe("Couldn't reach the server — it may be busy. Please try again in a moment.");
  });

  it('names the limit when the server was able to report one', () => {
    expect(getQueryErrorMessage({ message: 'RATE_LIMIT', data: { httpStatus: 429 } })).toBe(
      'Too many requests. Please wait a moment and try again.'
    );
  });

  it('passes a real server message through untouched', () => {
    expect(
      getQueryErrorMessage({ message: 'No Model with id 1', data: { httpStatus: 404 } })
    ).toBe('No Model with id 1');
  });
});
