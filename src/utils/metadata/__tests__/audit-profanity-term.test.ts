import { describe, expect, it } from 'vitest';
import { auditPromptEnriched, isSoftBlock } from '~/utils/metadata/audit';

/**
 * The profanity block reported the DATASET word it matched (`fuck`) rather than the word the
 * input actually carried (`fagus`). On the LoRA trainer that produced "Reason: fuck" over a tag
 * list containing no such word, which the user could not act on (ClickUp 868m5agjq).
 */
describe('the profanity block names the offending input word', () => {
  it.each([
    ['fagus tree', 'fagus'],
    ['great tit', 'tit'],
    ['what the fucking hell', 'fucking'],
  ])('%s -> %s', (prompt, offending) => {
    const { blockedFor, triggers, success } = auditPromptEnriched(prompt, undefined, true);
    expect(success).toBe(false);
    expect(blockedFor).toContain(offending);
    expect(triggers).toEqual([
      { category: 'profanity', message: offending, matchedWord: offending },
    ]);
  });

  it('names every distinct offending word', () => {
    const { blockedFor } = auditPromptEnriched('fagus grove, great tit', undefined, true);
    expect([...blockedFor].sort()).toEqual(['fagus', 'tit']);
  });

  it('stays a soft block — the severity model is unchanged', () => {
    const { triggers } = auditPromptEnriched('fagus tree', undefined, true);
    expect(isSoftBlock(triggers)).toBe(true);
  });
});

describe('the reported tag audit case', () => {
  it.each(['fu manchu mustache', '1girl, fu manchu mustache, solo', 'fu xi', 'fu dog'])(
    '%s passes on green',
    (prompt) => {
      expect(auditPromptEnriched(prompt, undefined, true)).toEqual({
        blockedFor: [],
        triggers: [],
        success: true,
      });
    }
  );

  it('is unaffected off green, where the profanity check never ran', () => {
    expect(auditPromptEnriched('fagus tree', undefined, false).success).toBe(true);
  });
});
