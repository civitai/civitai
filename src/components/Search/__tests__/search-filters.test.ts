import { describe, expect, it } from 'vitest';
import {
  buildBrowsingLevelClause,
  buildBrowsingLevelFilters,
  buildMinorExclusionFilter,
  joinFilterClauses,
} from '~/components/Search/search-filters';

const attribute = 'nsfwLevel' as const;
const pg = 1;
const pg13 = 2;
const r = 4;

describe('buildBrowsingLevelClause', () => {
  it('emits the same OR chain it has always emitted for a multi-bit level', () => {
    expect(buildBrowsingLevelClause(attribute, pg | pg13 | r)).toBe(
      'nsfwLevel=1 OR nsfwLevel=2 OR nsfwLevel=4'
    );
  });

  it('emits a single equality for a single-bit level', () => {
    expect(buildBrowsingLevelClause(attribute, pg)).toBe('nsfwLevel=1');
  });

  it('emits no clause for an empty browsing level', () => {
    expect(buildBrowsingLevelClause(attribute, 0)).toBeNull();
  });

  it('emits no clause without an attribute name', () => {
    expect(buildBrowsingLevelClause('', pg)).toBeNull();
  });
});

describe('buildBrowsingLevelFilters', () => {
  it('appends the browsing clause after the caller filters', () => {
    expect(
      buildBrowsingLevelFilters({ attribute, browsingLevel: pg, filters: ['type=Model'] })
    ).toEqual(['type=Model', 'nsfwLevel=1']);
  });

  it('accepts a single filter string', () => {
    expect(
      buildBrowsingLevelFilters({ attribute, browsingLevel: pg, filters: 'type=Model' })
    ).toEqual(['type=Model', 'nsfwLevel=1']);
  });

  it('drops the browsing clause entirely for an empty browsing level', () => {
    expect(buildBrowsingLevelFilters({ attribute, browsingLevel: 0 })).toEqual([]);
    expect(
      buildBrowsingLevelFilters({ attribute, browsingLevel: 0, filters: ['type=Model'] })
    ).toEqual(['type=Model']);
  });
});

describe('joinFilterClauses', () => {
  it('wraps each clause and joins with AND', () => {
    expect(joinFilterClauses(['type=Model', 'nsfwLevel=1'])).toBe('(type=Model) AND (nsfwLevel=1)');
  });

  it('wraps a single filter string', () => {
    expect(joinFilterClauses('type=Model')).toBe('(type=Model)');
  });

  it('returns an empty expression when there is nothing to filter on', () => {
    expect(joinFilterClauses(undefined)).toBe('');
    expect(joinFilterClauses([])).toBe('');
  });

  it('drops empty and whitespace-only clauses instead of wrapping them', () => {
    const filters = joinFilterClauses(['', '   ', 'type=Model']);

    expect(filters).toBe('(type=Model)');
    expect(filters).not.toContain('()');
  });
});

// Either guard alone hides the `()`, so the assembled expression is asserted separately from both.
describe('the expression BrowsingLevelFilter hands to ApplyCustomFilter', () => {
  it('is empty, not "()", when the browsing level is empty', () => {
    const filters = joinFilterClauses(buildBrowsingLevelFilters({ attribute, browsingLevel: 0 }));

    expect(filters).toBe('');
    expect(filters).not.toContain('()');
  });

  it('keeps only the caller filters when the browsing level is empty', () => {
    const filters = joinFilterClauses(
      buildBrowsingLevelFilters({ attribute, browsingLevel: 0, filters: ['type=Model'] })
    );

    expect(filters).toBe('(type=Model)');
    expect(filters).not.toContain('()');
  });

  it('is unchanged for a normal browsing level', () => {
    const filters = joinFilterClauses(
      buildBrowsingLevelFilters({
        attribute,
        browsingLevel: pg | pg13,
        filters: ['type=Model'],
      })
    );

    expect(filters).toBe('(type=Model) AND (nsfwLevel=1 OR nsfwLevel=2)');
  });
});

describe('buildMinorExclusionFilter', () => {
  const on = { disableMinor: true };
  const owner = { id: 7, username: 'owner' };

  it('exempts the viewer on models by id', () => {
    expect(
      buildMinorExclusionFilter({ targetIndex: 'models', addons: on, currentUser: owner })
    ).toBe('minor != true OR user.id = 7');
  });

  it('applies to everyone when no one is signed in', () => {
    expect(
      buildMinorExclusionFilter({ targetIndex: 'models', addons: on, currentUser: null })
    ).toBe('minor != true');
  });

  // The images index has no filterable user id, and the owner is never matched by username.
  it('exempts no one on images', () => {
    expect(
      buildMinorExclusionFilter({ targetIndex: 'images', addons: on, currentUser: owner })
    ).toBe('minor != true');
  });

  it('says nothing when the addon is off or the index has no minor attribute', () => {
    expect(
      buildMinorExclusionFilter({ targetIndex: 'models', addons: { disableMinor: false } })
    ).toBeNull();
    expect(buildMinorExclusionFilter({ targetIndex: 'articles', addons: on })).toBeNull();
  });
});
