import { describe, expect, it } from 'vitest';
import { auditTrainingLabels } from '~/components/Training/Form/training-label-audit';

/**
 * The trainer walled submission on every audit failure, including the overridable `profanity`
 * category, so a Danbooru tag carrying a bare `fu` blocked a whole dataset (ClickUp 868m5agjq).
 */

const labels = (...pairs: [string, string][]) => pairs.map(([key, label]) => ({ key, label }));

describe('auditTrainingLabels', () => {
  it('passes clean labels', () => {
    const result = auditTrainingLabels({
      triggerWord: 'mystyle',
      labels: labels(['a.png', '1girl, solo, smile']),
      checkProfanity: true,
    });
    expect(result).toEqual({
      severity: 'clean',
      offendingWords: [],
      triggerWordInvalid: false,
      invalidKeys: [],
    });
  });

  it('treats profanity as soft and names the offending word', () => {
    const result = auditTrainingLabels({
      triggerWord: '',
      labels: labels(['a.png', '1girl, fagus tree']),
      checkProfanity: true,
    });
    expect(result).toEqual({
      severity: 'soft',
      offendingWords: ['fagus'],
      triggerWordInvalid: false,
      invalidKeys: ['a.png'],
    });
  });

  it('keeps a minor-age label hard', () => {
    const result = auditTrainingLabels({
      triggerWord: '',
      labels: labels(['a.png', '8 year old girl']),
      checkProfanity: true,
    });
    expect(result.severity).toBe('hard');
    expect(result.invalidKeys).toEqual(['a.png']);
  });

  it('one hard label poisons an otherwise soft set', () => {
    const result = auditTrainingLabels({
      triggerWord: '',
      labels: labels(['a.png', 'fagus tree'], ['b.png', '8 year old girl']),
      checkProfanity: true,
    });
    expect(result.severity).toBe('hard');
    expect(result.invalidKeys).toEqual(['a.png', 'b.png']);
  });

  it('audits the trigger word separately', () => {
    const result = auditTrainingLabels({
      triggerWord: 'fagus',
      labels: labels(['a.png', '1girl']),
      checkProfanity: true,
    });
    expect(result).toEqual({
      severity: 'soft',
      offendingWords: ['fagus'],
      triggerWordInvalid: true,
      invalidKeys: [],
    });
  });

  it('skips the profanity check off green', () => {
    const result = auditTrainingLabels({
      triggerWord: 'fagus',
      labels: labels(['a.png', 'fagus tree']),
      checkProfanity: false,
    });
    expect(result.severity).toBe('clean');
  });

  it('audits each comma-separated tag on its own', () => {
    const result = auditTrainingLabels({
      triggerWord: '',
      labels: labels(['a.png', 'school_uniform, 1girl']),
      checkProfanity: true,
    });
    expect(result.severity).toBe('clean');
  });

  it('clears an empty label', () => {
    const result = auditTrainingLabels({
      triggerWord: '',
      labels: labels(['a.png', '']),
      checkProfanity: true,
    });
    expect(result).toEqual({
      severity: 'clean',
      offendingWords: [],
      triggerWordInvalid: false,
      invalidKeys: [],
    });
  });

  // `isSoftBlock` is false for an empty trigger set, and the over-length refusal reports none.
  it('keeps a failure carrying no triggers hard', () => {
    const result = auditTrainingLabels({
      triggerWord: '',
      labels: labels(['a.png', 'a'.repeat(20001)]),
      checkProfanity: true,
    });
    expect(result.severity).toBe('hard');
    expect(result.offendingWords).toEqual(['Prompt exceeds the maximum allowed length']);
  });

  it('dedupes offending words across labels', () => {
    const result = auditTrainingLabels({
      triggerWord: '',
      labels: labels(['a.png', 'fagus tree'], ['b.png', 'fagus grove']),
      checkProfanity: true,
    });
    expect(result.offendingWords).toEqual(['fagus']);
    expect(result.severity).toBe('soft');
  });

  it('passes the reported fu manchu tag', () => {
    const result = auditTrainingLabels({
      triggerWord: '',
      labels: labels(['a.png', '1girl, fu manchu mustache, solo']),
      checkProfanity: true,
    });
    expect(result.severity).toBe('clean');
  });
});
