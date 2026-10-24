import { describe, expect, it } from 'vitest';
import {
  aliasBreadth,
  appendAliases,
  modelRuleFormSchema,
  parseAliases,
  ruleMatchesText,
} from '$lib/model-rules';

describe('parseAliases', () => {
  it('splits on commas and newlines, trims and dedupes case-insensitively', () => {
    expect(parseAliases('Foo  \n foo\n\nBAZ  qux \nDoe, Jane')).toEqual([
      'Foo',
      'BAZ qux',
      'Doe, Jane',
    ]);
  });
});

describe('modelRuleFormSchema', () => {
  it('requires a subject and parses aliases', () => {
    expect(modelRuleFormSchema.safeParse({ subject: '  ' }).success).toBe(false);
    expect(modelRuleFormSchema.parse({ subject: ' A ', aliases: 'b\nc' })).toEqual({
      subject: 'A',
      description: '',
      aliases: ['b', 'c'],
      note: '',
    });
  });
});

describe('ruleMatchesText', () => {
  const rule = { subject: 'Jane Doe', description: 'Requested', aliases: ['JD'] };
  it('matches subject, alias and description case-insensitively', () => {
    expect(ruleMatchesText(rule, 'jane')).toBe(true);
    expect(ruleMatchesText(rule, 'jd')).toBe(true);
    expect(ruleMatchesText(rule, 'REQUEST')).toBe(true);
    expect(ruleMatchesText(rule, 'nobody')).toBe(false);
    expect(ruleMatchesText(rule, '  ')).toBe(true);
  });
});

describe('aliasBreadth', () => {
  it.each([
    ['Doe', 'single-word'],
    ['Jane', 'single-word'],
    ['Foo_Bar', null],
    ['Jane Doe', null],
    ['J D', 'short'],
    ['Al B', 'short'],
    ['Al Bo', null],
    ['Zoë', 'single-word'],
    ['  ', null],
  ])('%j -> %s', (alias, expected) => {
    expect(aliasBreadth(alias)).toBe(expected);
  });

  it('judges the form the matcher compares: punctuation separates words', () => {
    expect(aliasBreadth('Doe.')).toBe('single-word');
    expect(aliasBreadth('Jane-Doe')).toBeNull();
  });
});

describe('appendAliases', () => {
  it('appends new aliases one per line, skipping ones already there in any case', () => {
    expect(appendAliases('One\ntwo', ['Two', 'Three', 'three'])).toBe('One\ntwo\nThree');
  });

  it('works on an empty field', () => {
    expect(appendAliases('', ['A B'])).toBe('A B');
  });
});
