import { describe, expect, it } from 'vitest';
import {
  isSearchRefusedError,
  pageRefusal,
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
