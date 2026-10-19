import { describe, expect, it } from 'vitest';
import {
  auditTrainingLabels,
  labelAsTrained,
  packCaptionsForAudit,
} from '~/utils/metadata/training-label-audit';

/**
 * The trainer walled submission on every audit failure, including the overridable `profanity`
 * category, so a Danbooru tag carrying a bare `fu` blocked a whole dataset.
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

  it('marks no label for a trigger word that leads it as written to the dataset', () => {
    const result = auditTrainingLabels({
      triggerWord: 'fagus',
      labels: labels(['a.png', labelAsTrained('1girl', 'fagus', 'tag')]),
      checkProfanity: true,
    });
    expect(result.triggerWordInvalid).toBe(true);
    expect(result.invalidKeys).toEqual([]);
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

  // The over-length refusal carries a hard `over_length` trigger, so it lands hard.
  it('keeps an over-length label hard', () => {
    const result = auditTrainingLabels({
      triggerWord: '',
      labels: labels(['a.png', 'a'.repeat(20001)]),
      checkProfanity: true,
    });
    expect(result.severity).toBe('hard');
    expect(result.offendingWords).toEqual([
      'Prompt exceeds the maximum allowed length (20,000 characters)',
    ]);
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

describe('labelAsTrained', () => {
  it.each([
    ['tags', '1girl, solo', 'tag', 'mystyle, 1girl, solo'],
    ['a caption', 'a woman walking', 'caption', 'mystyle a woman walking'],
    ['an empty label', '', 'tag', 'mystyle'],
    ['tags already led by the trigger word', 'mystyle, 1girl', 'tag', 'mystyle, 1girl'],
    ['a caption already led by the trigger word', 'mystyle a woman', 'caption', 'mystyle a woman'],
    [
      'a tag that only starts with the trigger word',
      'mystyles, 1girl',
      'tag',
      'mystyle, mystyles, 1girl',
    ],
  ] as const)('leads %s with the trigger word once', (_l, label, type, expected) => {
    expect(labelAsTrained(label, 'mystyle', type)).toBe(expected);
  });

  it('matches a trigger word with regex characters literally', () => {
    expect(labelAsTrained('c++, 1girl', 'c++', 'tag')).toBe('c++, 1girl');
    expect(labelAsTrained('cx, 1girl', 'c.', 'tag')).toBe('c., cx, 1girl');
  });

  it('leaves a label alone without a trigger word', () => {
    expect(labelAsTrained('1girl', '', 'tag')).toBe('1girl');
  });
});

describe('packCaptionsForAudit', () => {
  const text = (length: number) => 'x'.repeat(length);

  it('fills a batch to exactly the cap, and splits one character past it', () => {
    expect(packCaptionsForAudit([text(6), text(3)], 10).map((b) => b.length)).toEqual([10]);
    expect(packCaptionsForAudit([text(6), text(4)], 10).map((b) => b.length)).toEqual([6, 4]);
  });

  it('never splits a caption: one over the cap is a batch of its own', () => {
    expect(packCaptionsForAudit(['a', text(15), 'b'], 10)).toEqual(['a', text(15), 'b']);
  });

  it('drops empty captions and keeps order', () => {
    expect(packCaptionsForAudit(['a', '', 'b'], 10)).toEqual(['a\nb']);
  });
});
