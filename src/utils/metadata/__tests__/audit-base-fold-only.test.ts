import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { nsfwPromptWords } from '@civitai/mod-utils/prompt-audit/lists';
import { hasNsfwWords } from '~/utils/metadata/audit-base';

const COMBINING_ACUTE = String.fromCharCode(0x301);

// Reads the import specifiers rather than matching prose, so a decoder cannot slip past on a
// spelling: double quotes, `require(`, a bare `import(`, or a deep path like `he/decode`.
function importSpecifiers(file: string) {
  const source = fs.readFileSync(file, 'utf-8');
  return [...source.matchAll(/(?:from|require\(|import\()\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

// A convention guard, kept next to its subject rather than in the `no-*` family: hasNsfwWords is
// reached from useApplyHiddenPreferences, which the feed renders on every page, so these two
// modules decide whether the entity table reaches the feed's initial chunk.
describe('audit-base folds accents without pulling in an entity decoder', () => {
  it('still matches a listed word spelled with an accent', () => {
    const word = nsfwPromptWords.find((w) => /^[a-z]{4,}$/.test(w) && /e[a-z]/.test(w));
    if (!word) throw new Error('no lowercase list word with a non-final `e` to build a fixture');

    const accented = word.replace(/e(?=[a-z])/, 'e' + COMBINING_ACUTE);

    // The mark has to land mid-word. `prepareWordRegex` ends every expression with a
    // not-followed-by-alphanumeric lookahead, which a trailing combining mark satisfies, so a
    // word-final accent would match with or without the fold and this case would prove nothing.
    expect(accented.endsWith(COMBINING_ACUTE)).toBe(false);
    // Legibility control: if this fails too, the word list or the regex builder moved and the
    // fold is not the explanation.
    expect(hasNsfwWords(word)).toBe(true);

    expect(hasNsfwWords(accented)).toBe(true);
  });

  // Separate case so it still reports when the one above fails.
  it('does not match ordinary text', () => {
    expect(hasNsfwWords('a perfectly ordinary title')).toBe(false);
  });

  it('audit-base pulls in no entity decoder', () => {
    const specifiers = importSpecifiers(path.join(__dirname, '..', 'audit-base.ts'));

    // Positive control on the extractor: it can see the import that IS there.
    expect(specifiers).toContain('~/utils/fold-diacritics');

    expect(
      specifiers.filter((s) => s === 'he' || s.startsWith('he/') || s.endsWith('normalize-text'))
    ).toEqual([]);
  });

  // The likeliest way the decoder comes back is not a revert here, it is someone teaching
  // foldDiacritics to decode entities so the two helpers stop disagreeing. The case above would
  // stay green through that; this one would not.
  it('the fold helper stays dependency-free', () => {
    const file = path.join(__dirname, '..', '..', 'fold-diacritics.ts');

    // Positive control: the file is the one we think it is, so an empty specifier list below
    // cannot come from reading the wrong path or an empty file.
    expect(fs.readFileSync(file, 'utf-8')).toContain('export function foldDiacritics');

    expect(importSpecifiers(file)).toEqual([]);
  });
});
