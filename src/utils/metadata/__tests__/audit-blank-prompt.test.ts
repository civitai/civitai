import { describe, expect, it } from 'vitest';
import {
  auditPromptEnriched,
  isBlankAuditInput,
  MAX_AUDIT_PROMPT_LENGTH,
} from '~/utils/metadata/audit';

/**
 * The empty-input fast path in `auditPromptEnriched` must require BOTH fields to be empty.
 *
 * It used to key on the prompt alone, so an empty prompt returned success before the length cap
 * and before any negative-prompt check ran — the negative prompt was not audited at all. These
 * cases pin that an empty prompt beside a non-empty negative prompt gets exactly the audit that
 * negative prompt gets beside a neutral non-empty prompt.
 */

// `tom cruise` is a real words-poi.json entry; the negative-prompt POI check fires on it.
const POI_NEGATIVE = 'tom cruise portrait';
const NEG_POI_MESSAGE = 'Negative prompt cannot include celebrity names';
const OVER_LENGTH_MESSAGE = 'Prompt exceeds the maximum allowed length (20,000 characters)';

const benign = (length: number) => 'a serene mountain landscape, '.repeat(length).slice(0, length);

describe('auditPromptEnriched — empty prompt with a non-empty negative prompt', () => {
  it.each([
    ['empty string', ''],
    ['whitespace only', '   \n\t '],
  ])('refuses a celebrity name in the negative prompt (prompt: %s)', (_label, prompt) => {
    expect(auditPromptEnriched(prompt, POI_NEGATIVE)).toEqual({
      blockedFor: [NEG_POI_MESSAGE],
      triggers: [{ category: 'poi', message: NEG_POI_MESSAGE, matchedWord: 'tom cruise' }],
      success: false,
    });
  });

  it('refuses an over-length negative prompt with the over_length trigger', () => {
    const negativePrompt = benign(MAX_AUDIT_PROMPT_LENGTH + 1);
    expect(negativePrompt.length).toBe(20001);

    expect(auditPromptEnriched('', negativePrompt)).toEqual({
      blockedFor: [OVER_LENGTH_MESSAGE],
      triggers: [{ category: 'over_length', message: OVER_LENGTH_MESSAGE }],
      success: false,
    });
  });

  it('refuses an over-length negative prompt that buries a banned term past the cap', () => {
    const negativePrompt = benign(MAX_AUDIT_PROMPT_LENGTH) + ' ' + POI_NEGATIVE;

    const result = auditPromptEnriched('', negativePrompt);
    expect(result.success).toBe(false);
    expect(result.triggers).toEqual([{ category: 'over_length', message: OVER_LENGTH_MESSAGE }]);
  });

  it('passes a benign negative prompt (the fast path is not replaced by a refusal)', () => {
    expect(auditPromptEnriched('', 'blurry, low quality, watermark')).toEqual({
      blockedFor: [],
      triggers: [],
      success: true,
    });
  });

  // Relationship, not a list of words: whatever a negative prompt yields beside a neutral
  // non-empty prompt, it must yield beside an empty one. The two refusing rows cover the length
  // cap and the negative-prompt POI check — the negative-prompt checks that run for every prompt.
  //
  // The 'mature' row is NOT coverage of the negative young-noun check: that check (and the
  // negative harmful-combination check) runs only when the PROMPT carries an NSFW term, so it
  // runs for neither an empty nor a neutral prompt. The row pins that this is unchanged — an
  // empty prompt gets exactly what a neutral one gets, no more.
  it.each([
    ['celebrity name', POI_NEGATIVE],
    ['over-length', benign(MAX_AUDIT_PROMPT_LENGTH + 10)],
    ['NSFW-gated negative term, not checked for a neutral prompt', 'mature'],
    ['benign', 'blurry, extra fingers'],
  ])('an empty prompt audits the negative prompt like a neutral prompt does (%s)', (_l, neg) => {
    expect(auditPromptEnriched('', neg)).toEqual(auditPromptEnriched('landscape', neg));
  });
});

describe('isBlankAuditInput', () => {
  it.each([
    ['both empty', '', '', true],
    ['both whitespace', ' \n', '\t ', true],
    ['prompt only', 'a cat', '', false],
    ['prompt only, negative absent', 'a cat', undefined, false],
    ['negative only', '', 'blurry', false],
    ['both present', 'a cat', 'blurry', false],
    ['both absent', undefined, undefined, true],
  ])('%s', (_label, prompt, negativePrompt, expected) => {
    expect(isBlankAuditInput(prompt, negativePrompt)).toBe(expected);
  });
});

// Invariant guard: these passed before the change too. They pin that the fast path still
// exists for genuinely empty input.
describe('auditPromptEnriched — both fields empty still takes the fast path', () => {
  it.each([
    ['empty, no negative', '', undefined],
    ['empty, empty', '', ''],
    ['whitespace, whitespace', '   ', '  \n '],
    // Over-length but whitespace only: there is still no content to audit.
    ['over-length whitespace, empty', ' '.repeat(MAX_AUDIT_PROMPT_LENGTH + 1), ''],
  ])('passes (%s)', (_label, prompt, negativePrompt) => {
    expect(auditPromptEnriched(prompt, negativePrompt)).toEqual({
      blockedFor: [],
      triggers: [],
      success: true,
    });
  });
});
