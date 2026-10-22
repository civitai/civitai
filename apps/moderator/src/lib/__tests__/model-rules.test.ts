import { describe, expect, it } from 'vitest';
import {
  mergeRuleMatches,
  modelRuleFormSchema,
  parseAliases,
  ruleChoicesOf,
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

describe('mergeRuleMatches', () => {
  it('lists the model\'s first match per rule, then literal-only hits, with subjects', () => {
    const subjects = new Map([
      [5, 'Subject Five'],
      [7, 'Subject Seven'],
    ]);
    expect(
      mergeRuleMatches(
        [{ ruleId: 5, reason: ' because ' }, { ruleId: 5, reason: 'again' }, 'x', { ruleId: 'y' }],
        [7, 5, 7],
        subjects
      )
    ).toEqual([
      { ruleId: 5, subject: 'Subject Five', reason: 'because', llm: true, literal: true },
      { ruleId: 7, subject: 'Subject Seven', reason: null, llm: false, literal: true },
    ]);
  });
});

describe('ruleChoicesOf', () => {
  it('lists each saved rule once, naming an unnamed one by its id and skipping ad hoc rules', () => {
    expect(
      ruleChoicesOf([
        { ruleId: 4, subject: 'Alice' },
        { ruleId: 4, subject: 'Alice again' },
        { ruleId: 7, subject: null },
        { ruleId: 0, subject: 'Ad hoc' },
        { ruleId: -1, subject: 'Draft' },
      ])
    ).toEqual([
      { id: 4, subject: 'Alice' },
      { id: 7, subject: 'Rule 7' },
    ]);
  });
});
