import { describe, expect, it } from 'vitest';
import { auditTrainingTriggerWord, labelAsTrained } from '~/utils/metadata/training-trigger-word';
import { MAX_AUDIT_PROMPT_LENGTH } from '~/utils/metadata/audit';

/** The trigger word rule the trainer's browser shares with every training submit. */

describe('auditTrainingTriggerWord', () => {
  it('passes a clean or empty trigger word', () => {
    expect(auditTrainingTriggerWord('mystyle', true)).toEqual({
      severity: 'clean',
      offendingWords: [],
    });
    expect(auditTrainingTriggerWord('', true)).toEqual({ severity: 'clean', offendingWords: [] });
  });

  it('warns on profanity where it is checked, naming the word', () => {
    expect(auditTrainingTriggerWord('fagus tree', true)).toEqual({
      severity: 'soft',
      offendingWords: ['fagus'],
    });
    expect(auditTrainingTriggerWord('fagus tree', false).severity).toBe('clean');
  });

  it('refuses a minor-age trigger word, and one longer than the audit reads', () => {
    expect(auditTrainingTriggerWord('8 year old girl', false).severity).toBe('hard');
    expect(auditTrainingTriggerWord('a'.repeat(MAX_AUDIT_PROMPT_LENGTH + 1), false).severity).toBe(
      'hard'
    );
  });
});

describe('labelAsTrained', () => {
  it.each([
    ['a cat', 'mystyle', 'caption', 'mystyle a cat'],
    ['1girl, solo', 'mystyle', 'tag', 'mystyle, 1girl, solo'],
    ['', 'mystyle', 'tag', 'mystyle'],
    ['a cat', '', 'caption', 'a cat'],
    ['mystyle', 'mystyle', 'tag', 'mystyle'],
    ['mystyle a cat', 'mystyle', 'caption', 'mystyle a cat'],
    ['mystyle, solo', 'mystyle', 'tag', 'mystyle, solo'],
    // Not a prefix match: the trigger word must be followed by the separator.
    ['mystyles, solo', 'mystyle', 'tag', 'mystyle, mystyles, solo'],
    // Regex characters in the trigger word are taken literally.
    ['solo', 'c++ (style)', 'tag', 'c++ (style), solo'],
    ['c++ (style), solo', 'c++ (style)', 'tag', 'c++ (style), solo'],
  ] as const)('%j led by %j as a %s is %j', (label, trigger, type, expected) => {
    expect(labelAsTrained(label, trigger, type)).toBe(expected);
  });
});
