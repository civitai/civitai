import { describe, expect, it } from 'vitest';
import { browserChecksProfanity, isSearchRefusedError } from '~/components/Search/search-refusal';
import { SEARCH_REFUSED_CODE } from '~/shared/constants/search-refusal.constants';

describe('browserChecksProfanity', () => {
  // The server always checks these, flag on or off, so the browser never needs to.
  it('leaves semantic search, and site search through the proxy, to the server', () => {
    expect([
      browserChecksProfanity({ via: 'semantic', proxyEnabled: false }),
      browserChecksProfanity({ via: 'semantic', proxyEnabled: true }),
      browserChecksProfanity({ via: 'siteSearch', proxyEnabled: true }),
    ]).toEqual([false, false, false]);
  });

  // Without the proxy the browser may query Meilisearch directly, where no server check runs.
  it('checks site search itself when the proxy is off', () => {
    expect(browserChecksProfanity({ via: 'siteSearch', proxyEnabled: false })).toBe(true);
  });
});

describe('isSearchRefusedError', () => {
  it('reads a semantic search refusal from its tRPC error', () => {
    expect(
      isSearchRefusedError({
        message: SEARCH_REFUSED_CODE,
        data: { code: 'UNPROCESSABLE_CONTENT' },
      })
    ).toBe(true);
  });

  it('reads an /api/search refusal before and after the Meilisearch adapter rethrows it', () => {
    expect(isSearchRefusedError({ code: SEARCH_REFUSED_CODE, message: SEARCH_REFUSED_CODE })).toBe(
      true
    );
    expect(isSearchRefusedError(new Error(`MeiliSearchApiError: ${SEARCH_REFUSED_CODE}`))).toBe(
      true
    );
  });

  it('is not fooled by other failures', () => {
    expect(
      [
        { message: 'invalid input', data: { code: 'UNPROCESSABLE_CONTENT' } },
        {
          message: 'Too many searches. Try again in a moment.',
          data: { code: 'TOO_MANY_REQUESTS' },
        },
        new Error('MeiliSearchCommunicationError: Failed to fetch'),
        null,
        'search_refused',
      ].map(isSearchRefusedError)
    ).toEqual([false, false, false, false, false]);
  });
});
