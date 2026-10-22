import { describe, expect, it } from 'vitest';
import { modelRuleFormSchema, parseAliases, ruleMatchesText } from '$lib/model-rules';

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
