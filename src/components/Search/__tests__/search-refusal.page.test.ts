import { describe, expect, it } from 'vitest';
import {
  isSearchRefusedError,
  pageRefusal,
  shownRefusalOf,
  throwIfRefused,
} from '~/components/Search/search-refusal';

describe("a semantic page's refusal", () => {
  it('reads a refused first page, with the moderator view only when the server sent it', () => {
    expect(pageRefusal({ refused: true })).toEqual({});
    expect(pageRefusal({ refused: true, refusedBy: 'query guard' })).toEqual({
      refusedBy: 'query guard',
    });
  });

  it('reads nothing from a page that was not refused, or from none', () => {
    expect(pageRefusal({ refused: false })).toBeUndefined();
    expect(pageRefusal(undefined)).toBeUndefined();
  });

  it("reads nothing from the previous search's placeholder page", () => {
    expect(pageRefusal({ refused: true }, true)).toBeUndefined();
  });

  it('rethrows a refused page as the refusal the search clients read', () => {
    let thrown: unknown;
    try {
      throwIfRefused({ items: [], refused: true });
    } catch (error) {
      thrown = error;
    }
    expect(isSearchRefusedError(thrown)).toBe(true);
    const page = { items: [1], refused: false };
    expect(throwIfRefused(page)).toBe(page);
  });
});

describe('what a searched feed shows', () => {
  const refusedError = { message: 'search_refused', data: { code: 'UNPROCESSABLE_CONTENT' } };

  it("puts the browser's own refusal first, with no server category", () => {
    expect(shownRefusalOf('poi', refusedError, { refusedBy: 'query guard' })).toEqual({
      refusal: 'poi',
    });
  });

  it('shows a refused error as the profanity refusal', () => {
    expect(shownRefusalOf(undefined, refusedError, undefined)).toEqual({ refusal: 'profanity' });
  });

  it("shows a server-refused page as the policy refusal, with the server's moderator view", () => {
    expect(shownRefusalOf(undefined, undefined, { refusedBy: 'query guard' })).toEqual({
      refusal: 'policy',
      refusedBy: 'query guard',
    });
    expect(shownRefusalOf(undefined, undefined, {})).toEqual({
      refusal: 'policy',
      refusedBy: undefined,
    });
  });

  it('shows nothing for a search that was not refused, or an outage', () => {
    expect(shownRefusalOf(undefined, undefined, undefined)).toBeUndefined();
    expect(shownRefusalOf(undefined, new Error('boom'), undefined)).toBeUndefined();
  });
});
