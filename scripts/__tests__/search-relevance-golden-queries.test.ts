import { describe, expect, it } from 'vitest';

import { defineGoldenSet, GOLDEN_QUERIES } from '../search-relevance-eval/golden-queries';

describe('defineGoldenSet', () => {
  it('accepts the committed set', () => {
    expect(GOLDEN_QUERIES.length).toBeGreaterThan(0);
  });

  it('refuses a typo whose canonical query is missing', () => {
    expect(() =>
      defineGoldenSet([
        { id: 'typo', kind: 'typo', text: 'homer simspon', canonical: 'gone', targets: ['images'] },
      ])
    ).toThrow(/not a canonical query/);
  });

  it('refuses a typo graded against another typo', () => {
    expect(() =>
      defineGoldenSet([
        { id: 'a', kind: 'typo', text: 'homer simspon', canonical: 'b', targets: ['images'] },
        { id: 'b', kind: 'typo', text: 'homer simpsom', canonical: 'a', targets: ['images'] },
      ])
    ).toThrow(/not a canonical query/);
  });

  it('refuses a typo on an index its canonical has no results for', () => {
    expect(() =>
      defineGoldenSet([
        { id: 'c', kind: 'canonical', text: 'homer simpson', targets: ['images'] },
        { id: 't', kind: 'typo', text: 'homer simspon', canonical: 'c', targets: ['models'] },
      ])
    ).toThrow(/targets models/);
  });

  it('refuses a duplicated id', () => {
    expect(() =>
      defineGoldenSet([
        { id: 'x', kind: 'canonical', text: 'flux', targets: ['models'] },
        { id: 'x', kind: 'canonical', text: 'Flux', targets: ['models'] },
      ])
    ).toThrow(/duplicated/);
  });
});
