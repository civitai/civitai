import { describe, expect, it } from 'vitest';
import {
  MAX_EXPECTED_RULES,
  expectedFromOutput,
  parseExpected,
  scoredLabels,
  workspaceOf,
} from './expected';

describe('parseExpected', () => {
  it('accepts a range and a range of one', () => {
    expect(parseExpected({ nsfw: { min: 'pg13', max: 'r' } }, 'Model')).toEqual({
      nsfw: { min: 'pg13', max: 'r' },
    });
    expect(parseExpected({ nsfw: { min: 'x', max: 'x' }, poi: false }, 'Model')).toEqual({
      nsfw: { min: 'x', max: 'x' },
      poi: false,
    });
  });

  it('refuses a range whose lowest level is above its highest', () => {
    expect(parseExpected({ nsfw: { min: 'x', max: 'pg13' } }, 'Model')).toMatch(/above/);
  });

  it('refuses a label the entity type does not score, naming the allowed ones', () => {
    expect(parseExpected({ scam: true }, 'Model')).toBe(
      'Model cases score nsfw, poi, minor, not scam.'
    );
  });

  it('treats an empty object as "score nothing"', () => {
    expect(parseExpected({}, 'CommentV2')).toEqual({});
  });

  it('dedupes and sorts expected rule ids, and refuses unsaved (negative) rules', () => {
    expect(parseExpected({ modelRules: { ruleIds: [9, 3, 9] } }, 'ModelRules')).toEqual({
      modelRules: { ruleIds: [3, 9] },
    });
    expect(parseExpected({ modelRules: { ruleIds: [-2] } }, 'ModelRules')).toBe(
      'Only saved rules can be expected.'
    );
  });

  it('refuses a non-object', () => {
    expect(parseExpected([], 'Model')).toBe('The expectation is malformed.');
    expect(parseExpected(null, 'Model')).toBe('The expectation is malformed.');
  });
});

describe('expectedFromOutput', () => {
  it('pins nsfw to a range of one and each flag to its verdict', () => {
    expect(
      expectedFromOutput(
        { nsfw: { level: 'r', reason: 'synthetic' }, poi: { detected: true }, minor: {} },
        ['nsfw', 'poi', 'minor'],
        null
      )
    ).toEqual({ nsfw: { min: 'r', max: 'r' }, poi: true });
  });

  it('expects the saved rules that matched and leaves unsaved ones out', () => {
    expect(expectedFromOutput(null, ['modelRules'], [5, -1, 2, 5])).toEqual({
      modelRules: { ruleIds: [2, 5] },
    });
  });

  it('leaves modelRules unscored when there was no answer to prefill from', () => {
    expect(expectedFromOutput(null, ['modelRules'], null)).toEqual({});
  });
});

describe('scoredLabels', () => {
  it('lists the labels an expectation scores, in label order', () => {
    expect(scoredLabels({ scam: false, nsfw: { min: 'none', max: 'none' } })).toEqual([
      'nsfw',
      'scam',
    ]);
  });
});

describe('capture prefill', () => {
  it('caps the prefilled rules at what parseExpected accepts', () => {
    const ids = Array.from({ length: MAX_EXPECTED_RULES + 50 }, (_, i) => i + 1);
    const prefill = expectedFromOutput(null, ['modelRules'], ids);
    expect(prefill.modelRules?.ruleIds).toHaveLength(MAX_EXPECTED_RULES);
    expect(typeof parseExpected(prefill, 'ModelRules')).toBe('object');
  });
});

describe('workspaceOf', () => {
  it('puts ModelRules cases in Model rules and everything else in Prompts', () => {
    expect(workspaceOf('ModelRules')).toBe('modelRules');
    expect(workspaceOf('Model')).toBe('prompts');
    expect(workspaceOf('CommentV2')).toBe('prompts');
  });
});
