import { describe, expect, it } from 'vitest';
import { matchSpec, type LabelRegexSpec } from '~/server/services/scanner-label-regex';

/**
 * `matchSpec` exists so an operator-supplied term list — kept out of this public repo — runs
 * through the SAME matcher as the committed specs. The properties asserted here are the ones a
 * hand-rolled `name.includes(term)` in a script would silently lose, and losing them means
 * flagging innocent models by substring, which is the documented failure of the profanity
 * filter this work replaces.
 */
const spec: LabelRegexSpec = {
  triggers: ['sex', 'pussy'],
  phrasePatterns: ['adult film'],
  carveOutPatterns: ['pussy\\s*willow'],
};

describe('matchSpec', () => {
  it('matches a trigger as a whole word', () => {
    expect(matchSpec('t', spec, 'Sex Scene LoRA').matched).toBe(true);
  });

  // The revert this protects against is dropping the word-boundary wrapper. Each of these
  // fails by name, so the output says which innocent word started matching.
  it.each(['Essex Countryside v2', 'Unisex Streetwear Pack', 'Sussex Spaniel', 'Sextant Study'])(
    'does not match inside a longer word: %s',
    (name) => {
      expect(matchSpec('t', spec, name).matched).toBe(false);
    }
  );

  it('strips carve-outs before looking for triggers', () => {
    expect(matchSpec('t', spec, 'Pussy Willow Branches').matched).toBe(false);
  });

  it('still matches the trigger when the carve-out context is absent', () => {
    expect(matchSpec('t', spec, 'pussy closeup').matched).toBe(true);
  });

  it('matches a multi-word phrase across variable whitespace', () => {
    expect(matchSpec('t', spec, 'Adult   Film Style').matched).toBe(true);
  });

  // The only case that separates `normalizePromptForRegex` from a bare `toLowerCase()`. Every
  // other case here passes either way — the matcher carries the `i` flag, and the phrase
  // builder does its own whitespace handling.
  it('strips A1111 weight syntax before matching', () => {
    expect(matchSpec('t', spec, '(adult:1.2) film').matched).toBe(true);
  });

  it('reports the term that matched, not just that something did', () => {
    expect(matchSpec('t', spec, 'Sex Scene LoRA').matchedTerms).toContain('sex');
  });
});
