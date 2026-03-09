import { describe, it, expect } from 'vitest';
import { translateFilters, translateSort, FilterClause, Value } from './filter-translator';

describe('translateFilters', () => {
  it('basic equality with integer', () => {
    expect(translateFilters('nsfwLevel = 1')).toEqual([
      { Eq: ['nsfwLevel', { Integer: 1 }] },
    ]);
  });

  it('basic equality with boolean', () => {
    expect(translateFilters('hasMeta = true')).toEqual([
      { Eq: ['hasMeta', { Bool: true }] },
    ]);
  });

  it('not equal', () => {
    expect(translateFilters('nsfwLevel != 32')).toEqual([
      { NotEq: ['nsfwLevel', { Integer: 32 }] },
    ]);
  });

  it('greater than', () => {
    expect(translateFilters('sortAtUnix > 1709251200000')).toEqual([
      { Gt: ['sortAtUnix', { Integer: 1709251200000 }] },
    ]);
  });

  it('greater than or equal', () => {
    expect(translateFilters('remixOfId >= 0')).toEqual([
      { Gte: ['remixOfId', { Integer: 0 }] },
    ]);
  });

  it('less than or equal', () => {
    expect(translateFilters('publishedAtUnix <= 1700000000000')).toEqual([
      { Lte: ['publishedAtUnix', { Integer: 1700000000000 }] },
    ]);
  });

  it('IN clause with integers', () => {
    expect(translateFilters('tagIds IN [4, 10]')).toEqual([
      { In: ['tagIds', [{ Integer: 4 }, { Integer: 10 }]] },
    ]);
  });

  it('IN clause with quoted strings', () => {
    expect(translateFilters("baseModel IN ['SD 1.5','SDXL']")).toEqual([
      { In: ['baseModel', [{ String: 'SD 1.5' }, { String: 'SDXL' }]] },
    ]);
  });

  it('NOT IN clause', () => {
    expect(translateFilters('tagIds NOT IN [4, 10]')).toEqual([
      { NotIn: ['tagIds', [{ Integer: 4 }, { Integer: 10 }]] },
    ]);
  });

  it('NOT EXISTS returns empty', () => {
    expect(translateFilters('blockedFor NOT EXISTS')).toEqual([]);
  });

  it('IS NULL returns empty', () => {
    expect(translateFilters('blockedFor IS NULL')).toEqual([]);
  });

  it('multiple AND-joined clauses', () => {
    const result = translateFilters('nsfwLevel IN [1,2] AND tagIds IN [4] AND hasMeta = true');
    expect(result).toEqual([
      { In: ['nsfwLevel', [{ Integer: 1 }, { Integer: 2 }]] },
      { In: ['tagIds', [{ Integer: 4 }]] },
      { Eq: ['hasMeta', { Bool: true }] },
    ]);
  });

  it('OR clause', () => {
    const result = translateFilters('nsfwLevel = 1 OR nsfwLevel = 2');
    expect(result).toEqual([
      { Or: [{ Eq: ['nsfwLevel', { Integer: 1 }] }, { Eq: ['nsfwLevel', { Integer: 2 }] }] },
    ]);
  });

  it('parenthesized OR with AND', () => {
    const result = translateFilters('(nsfwLevel = 1 OR nsfwLevel = 2) AND hasMeta = true');
    expect(result).toEqual([
      { Or: [{ Eq: ['nsfwLevel', { Integer: 1 }] }, { Eq: ['nsfwLevel', { Integer: 2 }] }] },
      { Eq: ['hasMeta', { Bool: true }] },
    ]);
  });

  it('NOT with boolean', () => {
    const result = translateFilters('NOT poi = true');
    expect(result).toEqual([
      { Not: { Eq: ['poi', { Bool: true }] } },
    ]);
  });

  it('NOT with parenthesized group', () => {
    const result = translateFilters('NOT (nsfwLevel IN [16,32] AND baseModel IN [\'SD 1.5\'])');
    expect(result).toEqual([
      { Not: { And: [
        { In: ['nsfwLevel', [{ Integer: 16 }, { Integer: 32 }]] },
        { In: ['baseModel', [{ String: 'SD 1.5' }]] },
      ]}},
    ]);
  });

  it('quoted field names', () => {
    expect(translateFilters('"userId" = 12345')).toEqual([
      { Eq: ['userId', { Integer: 12345 }] },
    ]);
  });

  it('dotted field name normalization (ignored field)', () => {
    // promptNsfw is excluded from BitDex — should be silently dropped
    expect(translateFilters('flags.promptNsfw = true')).toEqual([]);
  });

  it('combinedNsfwLevel remapped to nsfwLevel', () => {
    expect(translateFilters('combinedNsfwLevel IN [1,2,4]')).toEqual([
      { In: ['nsfwLevel', [{ Integer: 1 }, { Integer: 2 }, { Integer: 4 }]] },
    ]);
  });

  it('complex real-world filter: availability + blockedFor + nsfw', () => {
    const filter = '((NOT availability = 1) OR "userId" = 100) AND (("blockedFor" IS NULL OR "blockedFor" NOT EXISTS) OR "userId" = 100) AND (nsfwLevel IN [1,2,4] OR (nsfwLevel = 0 AND "userId" = 100))';
    const result = translateFilters(filter);
    // Should parse without throwing — structure check
    expect(result.length).toBeGreaterThan(0);
  });

  it('string array', () => {
    expect(translateFilters("blockedFor IN ['reason1','reason2']")).toEqual([
      { In: ['blockedFor', [{ String: 'reason1' }, { String: 'reason2' }]] },
    ]);
  });

  it('empty string returns empty', () => {
    expect(translateFilters('')).toEqual([]);
  });

  it('array of filter strings', () => {
    const result = translateFilters(['nsfwLevel = 1', 'hasMeta = true']);
    expect(result).toEqual([
      { Eq: ['nsfwLevel', { Integer: 1 }] },
      { Eq: ['hasMeta', { Bool: true }] },
    ]);
  });

  it('unquoted string value (type field)', () => {
    expect(translateFilters('type IN [image,video]')).toEqual([
      { In: ['type', [{ String: 'image' }, { String: 'video' }]] },
    ]);
  });

  it('NOT poi with OR user bypass', () => {
    const result = translateFilters('(NOT poi = true OR "userId" = 500)');
    expect(result).toEqual([
      { Or: [
        { Not: { Eq: ['poi', { Bool: true }] } },
        { Eq: ['userId', { Integer: 500 }] },
      ]},
    ]);
  });

  it('blockedFor equality with enum value', () => {
    const result = translateFilters('"blockedFor" = 5');
    expect(result).toEqual([
      { Eq: ['blockedFor', { Integer: 5 }] },
    ]);
  });

  it('nested AND within OR within AND', () => {
    const filter = '(postedToId = 123 OR modelVersionIds IN [123] OR modelVersionIdsManual IN [123]) AND hasMeta = true';
    const result = translateFilters(filter);
    expect(result).toHaveLength(2); // top-level AND flattened
  });
});

describe('translateSort', () => {
  it('descending sort', () => {
    expect(translateSort('reactionCount:desc')).toEqual({
      field: 'reactionCount',
      direction: 'Desc',
    });
  });

  it('ascending sort', () => {
    expect(translateSort('sortAt:asc')).toEqual({
      field: 'sortAt',
      direction: 'Asc',
    });
  });

  it('undefined for empty string', () => {
    expect(translateSort('')).toBeUndefined();
  });

  it('undefined for invalid format', () => {
    expect(translateSort('noColonHere')).toBeUndefined();
  });

  it('commentCount desc', () => {
    expect(translateSort('commentCount:desc')).toEqual({
      field: 'commentCount',
      direction: 'Desc',
    });
  });

  it('collectedCount desc', () => {
    expect(translateSort('collectedCount:desc')).toEqual({
      field: 'collectedCount',
      direction: 'Desc',
    });
  });
});
