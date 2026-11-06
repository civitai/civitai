import { describe, expect, it } from 'vitest';
import { quotedPhrases } from './quoted-phrases';

describe('quotedPhrases', () => {
  it('reads phrases quoted in single, double or curly quotes', () => {
    expect(
      quotedPhrases(
        `Mentions 'first phrase' and "second phrase", then “third phrase” and ‘fourth one’.`
      )
    ).toEqual(['first phrase', 'second phrase', 'third phrase', 'fourth one']);
  });

  it('does not take an apostrophe inside a word for a quote', () => {
    expect(
      quotedPhrases(`The author's text isn't what the 'quoted bit' says, nor the others' words`)
    ).toEqual(['quoted bit']);
  });

  it('finds nothing in a reason that quotes nothing, and drops empty or one-character quotes', () => {
    expect(quotedPhrases('Plain reason with no quotes')).toEqual([]);
    expect(quotedPhrases(`Odd '' and 'x' quotes`)).toEqual([]);
  });

  it('does not let a quote that never closes swallow the text up to the next one', () => {
    const rambling = 'x'.repeat(300);
    expect(quotedPhrases(`He wrote "start of ${rambling} and later "closed" here`)).toEqual([
      'closed',
    ]);
  });

  it('lists a repeated phrase once', () => {
    expect(quotedPhrases(`'same one' then "same one"`)).toEqual(['same one']);
  });
});
