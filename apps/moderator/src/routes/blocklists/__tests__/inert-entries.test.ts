import { describe, expect, it } from 'vitest';
import { inertEntries } from '../form';

describe('inertEntries', () => {
  it('rejects a multi-word Profanity Benign Word entry, which the filter can never match', () => {
    expect(inertEntries('ProfanityBenignWord', ['spreadsheet', 'fu manchu'])).toEqual([
      'fu manchu',
    ]);
  });

  it('rejects an entry the filter splits on punctuation', () => {
    expect(inertEntries('ProfanityBenignWord', ['fu-manchu', "o'cock"])).toEqual([
      'fu-manchu',
      "o'cock",
    ]);
  });

  it('accepts single-word entries', () => {
    expect(inertEntries('ProfanityBenignWord', ['cockpit', 'Scunthorpe', 'h3ll_o'])).toEqual([]);
  });

  it('leaves the phrase lists alone, where multi-word entries are the point', () => {
    expect(inertEntries('PromptBenignPhrase', ['teen titans'])).toEqual([]);
  });
});
