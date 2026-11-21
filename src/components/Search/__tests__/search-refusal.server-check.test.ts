import { describe, expect, it } from 'vitest';
import { browserChecksProfanity, isSearchRefusedError } from '~/components/Search/search-refusal';
import { SEARCH_REFUSED_CODE } from '~/shared/constants/search-refusal.constants';

describe('browserChecksProfanity', () => {
  const checks = (
    serverProfanity: boolean,
    via: 'semantic' | 'siteSearch',
    proxyEnabled: boolean
  ) => browserChecksProfanity({ serverProfanity, via, proxyEnabled });

  it('flag off: the browser checks on every path, as before', () => {
    expect([checks(false, 'semantic', true), checks(false, 'siteSearch', true)]).toEqual([
      true,
      true,
    ]);
  });

  it('flag on: the browser leaves semantic search and proxied site search to the server', () => {
    expect([checks(true, 'semantic', false), checks(true, 'siteSearch', true)]).toEqual([
      false,
      false,
    ]);
  });

  // Without the proxy the browser may query Meilisearch directly, where no server check runs.
  it('flag on, proxy off: the browser still checks site search', () => {
    expect(checks(true, 'siteSearch', false)).toBe(true);
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
