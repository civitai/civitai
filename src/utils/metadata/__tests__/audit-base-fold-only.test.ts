import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import nsfwPromptWords from '~/utils/metadata/lists/words-nsfw-prompt.json';
import { hasNsfwWords } from '~/utils/metadata/audit-base';

// hasNsfwWords is reached from useApplyHiddenPreferences, which the feed renders on every page, so
// this module decides whether `he`'s entity table (~98KB of source, ~25KB brotli) lands in the
// chunk the homepage loads. It did not before 4aede4ff99 was reverted, and it must not now.
describe('audit-base folds accents without pulling in an entity decoder', () => {
  it('still matches a listed word spelled with an accent', () => {
    const word = nsfwPromptWords.find((w) => /^[a-z]{4,}$/.test(w) && w.includes('e'));
    if (!word) throw new Error('no plain lowercase word with an e in the list to build a fixture');

    const accented = word.replace('e', String.fromCharCode(0x65, 0x301));

    expect(hasNsfwWords(accented)).toBe(true);
    // Negative control: the matcher is not simply returning true.
    expect(hasNsfwWords('a perfectly ordinary title')).toBe(false);
  });

  // A source-text guard, so state what it cannot see: it catches a DIRECT re-import only, not a
  // decoder arriving transitively through another module. Comment lines are stripped before
  // scanning, or the sentence above would fail it.
  it('does not import the entity decoder, directly', () => {
    const file = path.join(__dirname, '..', 'audit-base.ts');
    const code = fs
      .readFileSync(file, 'utf-8')
      .replace(/^\s*\/\/.*$/gm, '')
      .trim();

    // Positive control on the guard itself: it can see the import that IS there.
    expect(code).toContain("from '~/utils/fold-diacritics'");

    expect(code).not.toContain("from 'he'");
    expect(code).not.toContain('normalize-text');
  });
});
